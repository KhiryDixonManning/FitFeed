# app.py
"""FitFeed API.

Endpoints that touch user data or spend money on model calls require a
verified Firebase ID token. The caller's uid always comes from that token,
never from the request body.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from google.cloud.firestore import Increment as gcf_increment
from flask import Flask, g, jsonify, request
from flask_cors import CORS

from analysis_jobs import (
    MAX_ANALYSIS_ATTEMPTS,
    reset_attempts,
)
from auth import get_db, require_admin, require_auth
from interactions import (
    INTERACTION_SCHEMA_VERSION,
    TYPE_NOT_INTERESTED,
    fetch_not_interested_ids,
)
from job_queue import (
    JOBS_COLLECTION,
    STATUS_FAILED,
    enqueue_analysis,
)
from feed_cursor import CursorError, decode_cursor
from feed_service import (
    MODE_DISCOVER,
    MODE_FOLLOWING,
    attach_liked_by_me,
    build_for_you_page,
    fetch_discover,
    fetch_following,
    fetch_for_you_candidates,
    get_following_ids,
    select_followed_authors,
    serialize_post,
)
from style_vectors import post_style_vector, style_similarity
from taste_profile import get_taste_vector
from rate_limit import (
    ADMIN_LIMITER,
    ANALYZE_BURST,
    ANALYZE_SUSTAINED,
    RANK_BURST,
    RANK_SUSTAINED,
    rate_limit_by_peer,
    rate_limit_by_uid,
)
from recommendation_engine import get_trending, rank_posts
from validation import (
    MAX_TRENDING_POSTS,
    ValidationError,
    require_feed_request,
    require_interaction,
    require_json_object,
    require_post_id,
    validate_posts_payload,
    validate_preferences,
)

load_dotenv()

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("fitfeed.api")

app = Flask(__name__)

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "https://fitfeed-67ee8.web.app",
    "https://fitfeed-67ee8.firebaseapp.com",
]

CORS(
    app,
    origins=ALLOWED_ORIGINS,
    allow_headers=["Content-Type", "Authorization", "X-Admin-Key"],
    methods=["GET", "POST", "OPTIONS"],
    max_age=3600,
)

# How many posts one admin sweep may look at. A maintenance endpoint should
# not be able to walk an unbounded collection inside an HTTP request.
REANALYZE_SCAN_LIMIT = 500


# --------------------------------------------------------------- error plumbing

@app.errorhandler(ValidationError)
def handle_validation_error(err: ValidationError):
    return jsonify({"error": "invalid_request", "message": err.message}), err.status


@app.errorhandler(404)
def handle_not_found(_err):
    return jsonify({"error": "not_found", "message": "Not found."}), 404


@app.errorhandler(405)
def handle_method_not_allowed(_err):
    return jsonify({"error": "method_not_allowed", "message": "Method not allowed."}), 405


@app.errorhandler(Exception)
def handle_unexpected(err):
    # Full detail server-side, a generic message to the caller: internal
    # exception text can leak paths, credentials and library internals.
    log.exception("Unhandled error on %s %s", request.method, request.path)
    return jsonify({"error": "internal_error", "message": "Something went wrong."}), 500


# --------------------------------------------------------------------- routes

@app.route("/")
def home():
    return jsonify({"service": "FitFeed API", "status": "ok"})


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/feed", methods=["POST"])
@require_auth
@rate_limit_by_uid(RANK_BURST, RANK_SUSTAINED)
def feed():
    """Server-trusted, paginated feed.

    The client sends only a mode, page size, optional category and an opaque
    cursor. Candidates, engagement values and preferences are all read here
    from Firestore - nothing authoritative crosses the wire inbound.
    """
    data = require_json_object(request.get_json(silent=True))
    spec = require_feed_request(data)

    db = get_db()
    if db is None:
        return jsonify({"error": "unavailable", "message": "The feed is temporarily unavailable."}), 503

    cursor = None
    if spec.cursor:
        try:
            cursor = decode_cursor(spec.cursor, spec.mode, spec.category)
        except CursorError as exc:
            raise ValidationError(f"Invalid cursor: {exc}")

    if spec.mode == MODE_DISCOVER:
        page = fetch_discover(db, g.uid, spec.limit, spec.category, cursor)

    elif spec.mode == MODE_FOLLOWING:
        all_following = get_following_ids(db, g.uid)
        # Beyond the fan-out cap the author set is deterministically sampled,
        # and the response says so rather than silently dropping accounts.
        following_ids, following_sampled = select_followed_authors(all_following, g.uid)
        page = fetch_following(db, g.uid, spec.limit, spec.category, cursor, following_ids)
        following_meta = {
            "followingSampled": following_sampled,
            "followingTotal": len(all_following),
            "followingQueried": len(following_ids),
        }

    else:  # For You
        candidates = fetch_for_you_candidates(db, g.uid, spec.category, cursor)
        # Posts the user explicitly asked not to see again are removed before
        # ranking. This is a per-viewer filter only: it never touches the
        # post's own engagement or visibility for anyone else.
        hidden = fetch_not_interested_ids(db, g.uid)
        if hidden:
            candidates = [(pid, data) for pid, data in candidates if pid not in hidden]
        taste = get_taste_vector(db, g.uid)
        preferences = _load_preferences(db, g.uid)

        scored_input = [
            {**serialize_post(doc_id, raw, g.uid), "_raw": None}
            for doc_id, raw in candidates
        ]

        def matcher(post: dict) -> float:
            return style_similarity(taste, post_style_vector(post))

        ranked = rank_posts(
            scored_input,
            preferences,
            uid=g.uid,
            style_matcher=matcher,
            limit=spec.limit,
        )
        ranked_ids = [p["id"] for p in ranked if p.get("id")]
        page = build_for_you_page(candidates, ranked_ids, spec.limit, spec.category, g.uid)

        # Carry the ranking explanations onto the returned posts.
        factors_by_id = {p["id"]: p.get("_rankingFactors") for p in ranked}
        for post in page.posts:
            if factors_by_id.get(post["id"]):
                post["_rankingFactors"] = factors_by_id[post["id"]]

    log.info(
        "feed mode=%s uid=%s returned=%d candidates=%d queries=%d",
        spec.mode, g.uid, len(page.posts), page.candidates_considered, page.queries_issued,
    )
    attach_liked_by_me(db, page.posts, g.uid)

    body = {
        "posts": page.posts,
        "nextCursor": page.next_cursor,
        "hasMore": page.has_more,
        "mode": spec.mode,
        "category": spec.category,
    }
    if spec.mode == MODE_FOLLOWING:
        body.update(following_meta)
    return jsonify(body)


def _load_preferences(db, uid: str) -> dict:
    try:
        snapshot = db.collection("userPreferences").document(uid).get()
        if snapshot.exists:
            return validate_preferences(snapshot.to_dict())
    except Exception:
        log.exception("Could not load preferences for uid=%s", uid)
    return {}


@app.route("/trending", methods=["POST"])
@require_auth
@rate_limit_by_uid(RANK_BURST, RANK_SUSTAINED)
def trending():
    data = require_json_object(request.get_json(silent=True))
    posts = validate_posts_payload(data, MAX_TRENDING_POSTS)
    return jsonify(get_trending(posts))


@app.route("/analyze", methods=["POST"])
@require_auth
@rate_limit_by_uid(ANALYZE_BURST, ANALYZE_SUSTAINED)
def analyze():
    """Enqueue durable analysis for a post the caller owns.

    This no longer performs the analysis inline: it persists a job and
    returns. The worker picks it up, so closing the browser cannot cancel the
    work, and a slow model call cannot hold an HTTP request open.

    The client never supplies an image URL, and can only enqueue work for a
    post it authored - both are checked against Firestore, not the request.
    """
    data = require_json_object(request.get_json(silent=True))
    post_id = require_post_id(data)

    db = get_db()
    if db is None:
        return jsonify({
            "error": "unavailable",
            "message": "Analysis is temporarily unavailable.",
        }), 503

    snapshot = db.collection("posts").document(post_id).get()
    if not snapshot.exists:
        return jsonify({"error": "not_found", "message": "Post not found."}), 404

    post = snapshot.to_dict() or {}
    if post.get("authorId") != g.uid:
        log.warning("uid=%s attempted to enqueue analysis for a post it does not own", g.uid)
        return jsonify({"error": "forbidden", "message": "Not authorised for this post."}), 403

    if post.get("analyzed") is True:
        return jsonify({"status": "already_complete", "postId": post_id}), 200

    # A terminally failed job is not re-armed by an ordinary user request:
    # attempts are a spend budget, and resetting one is an operator action.
    job_snapshot = db.collection(JOBS_COLLECTION).document(post_id).get()
    if job_snapshot.exists:
        job = job_snapshot.to_dict() or {}
        if job.get("status") == STATUS_FAILED:
            return jsonify({
                "status": "failed",
                "postId": post_id,
                "reason": job.get("lastErrorCode") or "analysis_failed",
                "retryable": False,
            }), 200

    result = enqueue_analysis(db, post_id, g.uid)
    log.info("Analysis enqueued for post %s (uid=%s, created=%s)",
             post_id, g.uid, result.get("created"))
    return jsonify({"status": "queued", "postId": post_id}), 202


@app.route("/interactions", methods=["POST"])
@require_auth
@rate_limit_by_uid(RANK_BURST, RANK_SUSTAINED)
def record_interaction():
    """Record a recommendation signal for the calling user.

    The client may also write these directly to its own Firestore subtree
    (the rules permit exactly the same shape); this endpoint exists so the
    server can bump the taste-generation marker atomically alongside, and so
    explicit feedback works even when the client is offline-restricted.
    """
    data = require_json_object(request.get_json(silent=True))
    spec = require_interaction(data)

    db = get_db()
    if db is None:
        return jsonify({"error": "unavailable", "message": "Temporarily unavailable."}), 503

    # A signal may only reference a post that exists.
    if not db.collection("posts").document(spec.post_id).get().exists:
        return jsonify({"error": "not_found", "message": "Post not found."}), 404

    now = datetime.now(timezone.utc)
    doc_id = f"{spec.type}_{spec.post_id}"
    payload = {
        "postId": spec.post_id,
        "type": spec.type,
        "createdAt": now.isoformat(),
        "schemaVersion": INTERACTION_SCHEMA_VERSION,
    }
    if spec.value:
        payload["value"] = spec.value

    batch = db.batch()
    user_ref = db.collection("users").document(g.uid)
    batch.set(user_ref.collection("interactions").document(doc_id), payload)

    # Explicit feedback is mutually exclusive; recording one clears the other.
    opposite = {"more_like_this": "not_interested",
                "not_interested": "more_like_this"}.get(spec.type)
    if opposite:
        batch.delete(user_ref.collection("interactions").document(f"{opposite}_{spec.post_id}"))

    # Only explicit feedback is strong enough to justify an immediate rebuild.
    if spec.type in ("more_like_this", TYPE_NOT_INTERESTED):
        batch.set(
            db.collection("userTasteState").document(g.uid),
            {"generation": gcf_increment(1), "updatedAt": now},
            merge=True,
        )

    batch.commit()
    return jsonify({"status": "recorded", "type": spec.type, "postId": spec.post_id}), 200


@app.route("/reanalyze-all", methods=["POST"])
@rate_limit_by_peer(ADMIN_LIMITER)
@require_admin
def reanalyze_all():
    """Maintenance: queue analysis for posts that still need it.

    Gated behind ADMIN_API_KEY (X-Admin-Key header). Without that variable set
    the route reports 404 - see auth.require_admin.

    Dry run by default. A bulk reanalysis is real money and a real load
    spike, so it never starts as a side effect of calling this: the caller
    must pass {"apply": true}, and the dry run reports exactly what that
    would enqueue.

    Work is enqueued, never performed here. The HTTP request stays short
    regardless of how many posts match, the worker's lease keeps a redeploy
    from processing anything twice, and each post's attempt budget still
    applies. "resetAttempts" is the authorised administrative action that
    re-arms posts which have exhausted theirs - it is opt-in for the same
    reason.
    """
    data = request.get_json(silent=True)
    if data is not None and not isinstance(data, dict):
        return jsonify({"error": "invalid_request", "message": "Body must be an object."}), 400
    options = data or {}

    apply_changes = options.get("apply") is True
    reset_exhausted = options.get("resetAttempts") is True

    scan_limit = options.get("limit", REANALYZE_SCAN_LIMIT)
    if not isinstance(scan_limit, int) or isinstance(scan_limit, bool) or not 0 < scan_limit <= REANALYZE_SCAN_LIMIT:
        return jsonify({
            "error": "invalid_request",
            "message": f"limit must be an integer in 1..{REANALYZE_SCAN_LIMIT}.",
        }), 400

    db = get_db()
    if db is None:
        return jsonify({"error": "unavailable", "message": "Datastore is unavailable."}), 503

    queued = exhausted = skipped = scanned = 0

    for post_doc in db.collection("posts").limit(scan_limit).stream():
        scanned += 1
        post_data = post_doc.to_dict() or {}

        if not post_data.get("imageUrl"):
            skipped += 1
            continue

        palette = post_data.get("palette") or []
        has_old_palette = bool(palette) and isinstance(palette[0], str)
        missing_outfit_name = not post_data.get("outfitName")
        if post_data.get("analyzed") and not has_old_palette and not missing_outfit_name:
            skipped += 1
            continue

        attempts = post_data.get("analysisAttempts") or 0
        if not isinstance(attempts, int) or attempts < 0:
            attempts = 0
        if attempts >= MAX_ANALYSIS_ATTEMPTS and not reset_exhausted:
            # Already spent its budget; re-arming it is a deliberate choice.
            exhausted += 1
            continue

        if apply_changes:
            if attempts >= MAX_ANALYSIS_ATTEMPTS:
                reset_attempts(db, post_doc.id)
            enqueue_analysis(db, post_doc.id, post_data.get("authorId") or "admin")
        queued += 1

    log.info(
        "Reanalysis sweep: apply=%s scanned=%d queued=%d exhausted=%d skipped=%d",
        apply_changes, scanned, queued, exhausted, skipped,
    )
    return jsonify({
        "status": "queued" if apply_changes else "dry_run",
        "applied": apply_changes,
        "scanned": scanned,
        # On a dry run this is what *would* be enqueued.
        "queued": queued,
        "exhaustedSkipped": exhausted,
        "skipped": skipped,
        "scanLimit": scan_limit,
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
