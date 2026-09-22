# taste_profile.py
"""User taste vectors, derived from real interaction signals.

The profile is a versioned aggregate of the style vectors of posts the user
actually engaged with, blended with the existing category counters. It is
cached in Firestore (userTasteVectors/{uid}) and rebuilt when stale, so the
feed path costs one document read rather than a fan-out per request.

Signal weights (v2). Every one of these corresponds to something a user
actually did; nothing is inferred or approximated:

    more_like_this   6.0   an explicit "show me more of this"
    save             3.0   deliberate, private, high intent
    comment          2.5   costs effort, usually specific
    like             1.5   cheap but plentiful
    category         1.0   the legacy userPreferences counters, as a baseline
    view             0.4   the post held attention past a threshold
    impression       0.1   the post was meaningfully on screen
    not_interested  -4.0   an explicit "less of this"

The passive signals are deliberately an order of magnitude weaker than the
explicit ones: impressions are plentiful and nearly free to generate, so they
inform taste without being able to define it. Because impressions and views
are deduplicated per (user, post), a single post contributes at most one of
each no matter how often it is scrolled past - so passive signal cannot be
farmed by re-showing the same content.

Negative feedback subtracts from the dimensions it touches, then the whole
vector is floored at zero and renormalised. That keeps the space bounded in
both directions: a dislike can drive a dimension to zero but never negative,
and cannot produce an unbounded negative vector.

Bounding and decay: every contribution is weighted by a recency factor with a
half-life, and the final vector is normalised to a 0..1 range. Preferences
therefore cannot grow without limit, and old taste fades rather than being
frozen in forever.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from google.cloud import firestore as gcf

from interactions import (
    INTERACTION_TYPES,
    TYPE_MORE_LIKE_THIS,
    TYPE_NOT_INTERESTED,
    fetch_interactions,
)
from style_vectors import (
    STYLE_VECTOR_VERSION,
    canonical_aesthetic,
    post_style_vector,
)

log = logging.getLogger(__name__)

# v2 adds impressions, dwell views and explicit more/less feedback. The bump
# invalidates every v1 cache automatically.
TASTE_VECTOR_VERSION = 2
TASTE_COLLECTION = "userTasteVectors"
# Bumped by the client on every taste-relevant interaction. A cached vector
# built from an older generation is stale regardless of its age, so a like or
# save is reflected on the next feed request instead of up to CACHE_TTL later.
TASTE_STATE_COLLECTION = "userTasteState"

SIGNAL_WEIGHTS = {
    "more_like_this": 6.0,
    "save": 3.0,
    "comment": 2.5,
    "like": 1.5,
    "category": 1.0,
    "view": 0.4,
    "impression": 0.1,
    "not_interested": -4.0,
}

# Interaction influence halves every 30 days.
DECAY_HALF_LIFE_DAYS = 30.0

# Bound the work a rebuild can do.
MAX_LIKED_POSTS = 60
MAX_SAVED_POSTS = 60
MAX_INTERACTION_POSTS = 120

# How long a cached vector is served before being rebuilt.
CACHE_TTL_SECONDS = 6 * 3600


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware(value: Any) -> Optional[datetime]:
    """Best-effort timezone-aware datetime, or None if it is not a time.

    Likes, saves and interaction signals are all written by the browser as
    ISO strings, so string parsing is the common case here, not the exotic
    one - handling only datetime objects silently disabled decay for every
    client-written signal. Anything genuinely unparseable returns None, which
    the caller treats as "unknown age" rather than as "brand new".
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    # Firestore serialised timestamps, as they appear in exported documents.
    if isinstance(value, dict):
        seconds = value.get("_seconds", value.get("seconds"))
        if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
            try:
                return datetime.fromtimestamp(seconds, tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                return None

    return None


def _recency_weight(created_at: Any, now: datetime) -> float:
    """Exponential decay so taste drifts instead of accumulating forever.

    createdAt is client-supplied and the rules can only require that it is a
    string, so this clamps rather than trusts: a signal dated in the future
    counts exactly as much as one written now, never more. Backdating is
    equally pointless - it only makes a signal weaker.
    """
    created = _as_aware(created_at)
    if created is None:
        return 0.5  # unknown age: count it, but weakly
    age_days = max((now - created).total_seconds() / 86400.0, 0.0)
    return 0.5 ** (age_days / DECAY_HALF_LIFE_DAYS)


def _accumulate(target: dict[str, dict[str, float]], vector: dict, weight: float) -> None:
    for facet in ("aesthetics", "tags", "items", "colors"):
        values = vector.get(facet)
        if not isinstance(values, dict):
            continue
        bucket = target.setdefault(facet, {})
        for key, value in values.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            if not math.isfinite(float(value)):
                continue
            bucket[key] = bucket.get(key, 0.0) + float(value) * weight


def _normalize(target: dict[str, dict[str, float]], max_dims: int = 24) -> dict[str, dict[str, float]]:
    """Scale each facet to [0,1] and cap dimensionality.

    Negative accumulations (from explicit "not interested") are floored at
    zero rather than carried through: a disliked dimension drops out of the
    profile, but the vector can never go negative or unbounded.
    """
    out: dict[str, dict[str, float]] = {}
    for facet, values in target.items():
        positive = {
            k: v for k, v in values.items()
            if isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(float(v)) and v > 0
        }
        if not positive:
            continue
        top = sorted(positive.items(), key=lambda kv: kv[1], reverse=True)[:max_dims]
        peak = max(v for _, v in top)
        if peak <= 0:
            continue
        out[facet] = {k: round(min(v / peak, 1.0), 4) for k, v in top if v / peak >= 0.05}
    return out


def build_taste_vector(
    db,
    uid: str,
    now: Optional[datetime] = None,
    preferences: Optional[dict] = None,
) -> dict:
    """Recompute a user's taste vector from source data.

    Reads are bounded: one query for liked posts, one for saves plus a
    batched lookup of those posts, and the caller's preference document.
    """
    moment = now or _utcnow()
    accumulator: dict[str, dict[str, float]] = {}
    counted = {key: 0 for key in SIGNAL_WEIGHTS}

    # --- category counters (the legacy signal, used as a baseline) ---
    prefs = preferences
    if prefs is None:
        try:
            snap = db.collection("userPreferences").document(uid).get()
            prefs = snap.to_dict() if snap.exists else {}
        except Exception:
            log.exception("Could not read preferences for uid=%s", uid)
            prefs = {}

    if isinstance(prefs, dict):
        peak = max((v for v in prefs.values()
                    if isinstance(v, (int, float)) and not isinstance(v, bool)), default=0)
        for key, value in prefs.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                continue
            canonical = canonical_aesthetic(key)
            if not canonical or peak <= 0:
                continue
            strength = min(float(value) / float(peak), 1.0)
            _accumulate(
                accumulator,
                {"aesthetics": {canonical: strength}},
                SIGNAL_WEIGHTS["category"],
            )
            counted["category"] += 1

    # --- liked posts ---
    # Likes live in posts/{id}/likes/{uid}; one collection-group query finds
    # every post this user liked without scanning the posts collection.
    liked_post_ids: list[str] = []
    try:
        like_docs = (
            db.collection_group("likes")
            .where(filter=gcf.FieldFilter("uid", "==", uid))
            .limit(MAX_LIKED_POSTS)
            .stream()
        )
        for doc in like_docs:
            parent_post = doc.reference.parent.parent
            if parent_post is not None:
                liked_post_ids.append(parent_post.id)
    except Exception:
        log.exception("Could not read like documents for uid=%s", uid)

    try:
        for chunk_start in range(0, len(liked_post_ids), 10):
            chunk = liked_post_ids[chunk_start:chunk_start + 10]
            refs = [db.collection("posts").document(pid) for pid in chunk]
            for snap in db.get_all(refs):
                if not snap.exists:
                    continue
                data = snap.to_dict() or {}
                weight = SIGNAL_WEIGHTS["like"] * _recency_weight(data.get("createdAt"), moment)
                _accumulate(accumulator, post_style_vector(data), weight)
                counted["like"] += 1
    except Exception:
        log.exception("Could not read liked posts for uid=%s", uid)

    # --- saved posts ---
    try:
        saves = (
            db.collection("saves")
            .where(filter=gcf.FieldFilter("uid", "==", uid))
            .limit(MAX_SAVED_POSTS)
            .stream()
        )
        saved_ids = [(d.to_dict() or {}).get("postId") for d in saves]
        saved_ids = [pid for pid in saved_ids if isinstance(pid, str) and pid][:MAX_SAVED_POSTS]

        for chunk_start in range(0, len(saved_ids), 10):
            chunk = saved_ids[chunk_start:chunk_start + 10]
            refs = [db.collection("posts").document(pid) for pid in chunk]
            for snap in db.get_all(refs):
                if not snap.exists:
                    continue
                data = snap.to_dict() or {}
                weight = SIGNAL_WEIGHTS["save"] * _recency_weight(data.get("createdAt"), moment)
                _accumulate(accumulator, post_style_vector(data), weight)
                counted["save"] += 1
    except Exception:
        log.exception("Could not read saved posts for uid=%s", uid)

    # --- explicit and passive interaction signals (Phase 7) ---
    try:
        events = fetch_interactions(db, uid)
        wanted_ids: dict[str, list[dict]] = {}
        for event in events:
            event_type = event.get("type")
            post_id = event.get("postId")
            if event_type not in INTERACTION_TYPES or not isinstance(post_id, str):
                continue
            wanted_ids.setdefault(post_id, []).append(event)

        post_ids = list(wanted_ids)[:MAX_INTERACTION_POSTS]
        for chunk_start in range(0, len(post_ids), 10):
            chunk = post_ids[chunk_start:chunk_start + 10]
            refs = [db.collection("posts").document(pid) for pid in chunk]
            for snap in db.get_all(refs):
                if not snap.exists:
                    continue
                data = snap.to_dict() or {}
                vector_for_post = post_style_vector(data)
                for event in wanted_ids.get(snap.id, []):
                    event_type = event["type"]
                    weight = SIGNAL_WEIGHTS.get(event_type, 0.0)
                    if not weight:
                        continue
                    # Explicit feedback is not time-decayed: a deliberate
                    # "less of this" should not quietly expire.
                    if event_type in (TYPE_MORE_LIKE_THIS, TYPE_NOT_INTERESTED):
                        _accumulate(accumulator, vector_for_post, weight)
                    else:
                        # Decay by when the USER acted, not by how old the
                        # post is: scrolling past a two-year-old post today
                        # is a signal about today. Falls back to the post's
                        # own timestamp when the event has no usable one.
                        recency = _recency_weight(
                            event.get("createdAt") or data.get("createdAt"), moment
                        )
                        _accumulate(accumulator, vector_for_post, weight * recency)
                    counted[event_type] = counted.get(event_type, 0) + 1
    except Exception:
        log.exception("Could not apply interaction signals for uid=%s", uid)

    vector = _normalize(accumulator)
    return {
        "version": TASTE_VECTOR_VERSION,
        "styleVectorVersion": STYLE_VECTOR_VERSION,
        "updatedAt": moment,
        "signals": counted,
        "isEmpty": not any(vector.values()),
        **vector,
    }


def read_taste_generation(db, uid: str) -> int:
    """Current interaction generation for a user (0 when never recorded)."""
    try:
        snap = db.collection(TASTE_STATE_COLLECTION).document(uid).get()
        if not snap.exists:
            return 0
        value = (snap.to_dict() or {}).get("generation", 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0
        return int(value)
    except Exception:
        log.exception("Could not read taste generation for uid=%s", uid)
        return 0


def _is_fresh(cached: dict, now: datetime, generation: int) -> bool:
    """A cache entry is usable only if it is current in every dimension.

    Version, algorithm version, wall-clock age, and - critically - the
    interaction generation it was built from. Without the generation check a
    like would not influence ranking for up to CACHE_TTL_SECONDS.
    """
    if cached.get("version") != TASTE_VECTOR_VERSION:
        return False
    if cached.get("styleVectorVersion") != STYLE_VECTOR_VERSION:
        return False
    built_from = cached.get("builtFromGeneration")
    if isinstance(built_from, bool) or not isinstance(built_from, (int, float)):
        return False
    if int(built_from) < generation:
        return False
    updated = _as_aware(cached.get("updatedAt"))
    if updated is None:
        return False
    return (now - updated) < timedelta(seconds=CACHE_TTL_SECONDS)


def get_taste_vector(db, uid: str, now: Optional[datetime] = None,
                     force_rebuild: bool = False) -> dict:
    """Cached taste vector, rebuilt when missing, stale or version-bumped.

    A version bump invalidates every cached vector automatically, which is
    what makes the algorithm migratable.
    """
    moment = now or _utcnow()
    doc_ref = db.collection(TASTE_COLLECTION).document(uid)
    generation = read_taste_generation(db, uid)

    if not force_rebuild:
        try:
            snap = doc_ref.get()
            if snap.exists:
                cached = snap.to_dict() or {}
                if _is_fresh(cached, moment, generation):
                    return cached
        except Exception:
            log.exception("Could not read cached taste vector for uid=%s", uid)

    vector = build_taste_vector(db, uid, moment)
    vector["builtFromGeneration"] = generation
    try:
        doc_ref.set(vector)
    except Exception:
        log.exception("Could not cache taste vector for uid=%s", uid)
    return vector
