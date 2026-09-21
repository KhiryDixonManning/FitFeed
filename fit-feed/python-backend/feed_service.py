# feed_service.py
"""Server-trusted candidate retrieval for the feed.

The browser no longer sends post objects to be ranked. It sends only a mode, a
page size, an optional category and an opaque cursor; every authoritative value
(engagement counts, author, category, analysis output) is read here from
Firestore with the Admin SDK.

Read complexity per page
------------------------
    For You    1 query, <= CANDIDATE_WINDOW document reads (default 60)
    Discover   1 query, <= limit document reads
    Following  ceil(F/10) queries where F = followed authors (Firestore's
               `in` limit), <= ceil(F/10) * limit document reads, merged and
               truncated to limit
    plus       1 read of userPreferences and at most 1 of userTasteVectors
               (Phase 6), both per request, not per post

Nothing here is O(collection): every query carries a limit, and the Following
fan-out is bounded by how many accounts the caller follows.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from google.cloud import firestore as gcf

from feed_cursor import FeedCursor, encode_cursor

log = logging.getLogger(__name__)

MODE_FOR_YOU = "foryou"
MODE_DISCOVER = "discover"
MODE_FOLLOWING = "following"
FEED_MODES = (MODE_FOR_YOU, MODE_DISCOVER, MODE_FOLLOWING)

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 30

# For You scores a window of recent posts and returns the best page of it.
# Pages advance by window, so a post is never shown twice.
CANDIDATE_WINDOW = 60
MAX_CANDIDATE_WINDOW = 100

# Firestore allows at most 10 values in an `in` filter.
IN_QUERY_CHUNK = 10
# Bound the fan-out for users following very many accounts.
MAX_FOLLOW_CHUNKS = 10
# Hard cap on authors queried for one Following page: 10 chunks x 10 ids.
MAX_FOLLOWED_AUTHORS = IN_QUERY_CHUNK * MAX_FOLLOW_CHUNKS
# Upper bound on follow documents read before sampling.
MAX_FOLLOW_SCAN = 500

# Fields returned to the client. likedBy is deliberately excluded - it can be
# large and the client only needs to know whether *it* liked the post.
POST_PUBLIC_FIELDS = (
    "authorId", "content", "imageUrl", "category", "outfitBreakdown",
    "likesCount", "commentsCount", "createdAt", "analyzed", "analysisStatus",
    "palette", "aesthetic", "outfitName", "aestheticTags", "detectedItems",
    "styleDescription", "styleNotes", "aestheticScores",
)


@dataclass
class FeedPage:
    posts: list[dict] = field(default_factory=list)
    next_cursor: Optional[str] = None
    has_more: bool = False
    candidates_considered: int = 0
    queries_issued: int = 0


def _safe_int(value: Any) -> int:
    """Counters are server-written but legacy rows may hold junk."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        number = int(value)
    except (ValueError, OverflowError):
        return 0
    return max(number, 0)


def _to_utc(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return None


def serialize_post(doc_id: str, data: dict, viewer_uid: str) -> dict:
    """Trusted projection of a post for the client."""
    out: dict[str, Any] = {"id": doc_id}
    for key in POST_PUBLIC_FIELDS:
        if key in data:
            out[key] = data[key]

    created = _to_utc(data.get("createdAt"))
    out["createdAt"] = created.isoformat() if created else None

    # likedByMe is resolved from the likes subcollection by
    # attach_liked_by_me, never from the legacy likedBy array.
    #
    # Seeding it from the array looks like a helpful migration fallback and is
    # actually a permanent bug: no client can write likedBy under the strict
    # rules, so the array is never cleaned. A user who liked a post before the
    # migration and unlikes it afterwards would delete their like document,
    # decrement the counter - and still be shown as having liked it, forever.
    #
    # The subcollection is authoritative instead, which the deploy order
    # guarantees is complete: migrate_likes.py --apply runs to a clean --verify
    # before this backend ships, and again at the end of the compatibility
    # window to pick up anything an old client wrote during it.
    out["likedByMe"] = False
    out["likesCount"] = _safe_int(data.get("likesCount"))
    out["commentsCount"] = _safe_int(data.get("commentsCount"))
    return out


def _ordered_posts_query(db, category: Optional[str]):
    query = db.collection("posts")
    if category:
        query = query.where(filter=gcf.FieldFilter("category", "==", category))
    return query.order_by("createdAt", direction=gcf.Query.DESCENDING)


def _apply_cursor(query, cursor: Optional[FeedCursor]):
    if cursor is None:
        return query
    # start_after on the ordering field; the id in the cursor is used to drop
    # an exact-timestamp duplicate if one ever occurs.
    return query.start_after({"createdAt": cursor.created_at})


def _collect(snapshot_iter, viewer_uid: str, skip_id: Optional[str]) -> list[tuple[str, dict]]:
    rows: list[tuple[str, dict]] = []
    for doc in snapshot_iter:
        if skip_id and doc.id == skip_id:
            continue
        data = doc.to_dict() or {}
        if not data.get("createdAt"):
            continue  # unordered/corrupt row would break pagination
        rows.append((doc.id, data))
    return rows


def _page_from_rows(
    rows: list[tuple[str, dict]],
    limit: int,
    mode: str,
    category: Optional[str],
    viewer_uid: str,
    more_available: bool,
) -> FeedPage:
    page_rows = rows[:limit]
    posts = [serialize_post(doc_id, data, viewer_uid) for doc_id, data in page_rows]

    next_cursor = None
    if page_rows and more_available:
        last_id, last_data = page_rows[-1]
        created = _to_utc(last_data.get("createdAt"))
        if created:
            next_cursor = encode_cursor(created, last_id, mode, category)

    return FeedPage(
        posts=posts,
        next_cursor=next_cursor,
        has_more=bool(next_cursor),
        candidates_considered=len(rows),
    )


# ------------------------------------------------------------------ discover

def fetch_discover(db, viewer_uid: str, limit: int, category: Optional[str],
                   cursor: Optional[FeedCursor]) -> FeedPage:
    """Chronological discovery. One bounded query per page."""
    query = _apply_cursor(_ordered_posts_query(db, category), cursor)
    # Fetch one extra to learn whether another page exists.
    rows = _collect(query.limit(limit + 1).stream(), viewer_uid,
                    cursor.post_id if cursor else None)
    page = _page_from_rows(rows, limit, MODE_DISCOVER, category, viewer_uid,
                           more_available=len(rows) > limit)
    page.queries_issued = 1
    return page


# ----------------------------------------------------------------- following

def fetch_following(db, viewer_uid: str, limit: int, category: Optional[str],
                    cursor: Optional[FeedCursor], following_ids: list[str]) -> FeedPage:
    """Posts from followed accounts only.

    Firestore caps `in` filters at 10 values, so the author list is chunked and
    the per-chunk results are merged. Each chunk carries the same ordering and
    limit, so the merge is a bounded k-way merge - never a full-collection read.
    """
    if not following_ids:
        return FeedPage(posts=[], next_cursor=None, has_more=False)

    chunks = [
        following_ids[i:i + IN_QUERY_CHUNK]
        for i in range(0, len(following_ids), IN_QUERY_CHUNK)
    ][:MAX_FOLLOW_CHUNKS]

    merged: list[tuple[str, dict]] = []
    for chunk in chunks:
        query = db.collection("posts").where(filter=gcf.FieldFilter("authorId", "in", chunk))
        query = query.order_by("createdAt", direction=gcf.Query.DESCENDING)
        query = _apply_cursor(query, cursor)
        merged.extend(
            _collect(query.limit(limit + 1).stream(), viewer_uid,
                     cursor.post_id if cursor else None)
        )

    # Category is filtered in memory for this mode: combining an `in` filter,
    # an equality filter and an ordering would need a three-field composite
    # index for a query whose result set is already bounded by the fan-out.
    if category:
        merged = [(i, d) for i, d in merged if d.get("category") == category]

    merged.sort(key=lambda row: _to_utc(row[1].get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True)

    page = _page_from_rows(merged, limit, MODE_FOLLOWING, category, viewer_uid,
                           more_available=len(merged) > limit)
    page.queries_issued = len(chunks)
    return page


# -------------------------------------------------------------------- for you

def fetch_for_you_candidates(db, viewer_uid: str, category: Optional[str],
                             cursor: Optional[FeedCursor],
                             window: int = CANDIDATE_WINDOW) -> list[tuple[str, dict]]:
    """A bounded recency window of candidates for the ranker to choose from."""
    window = max(1, min(window, MAX_CANDIDATE_WINDOW))
    query = _apply_cursor(_ordered_posts_query(db, category), cursor)
    return _collect(query.limit(window + 1).stream(), viewer_uid,
                    cursor.post_id if cursor else None)


def build_for_you_page(candidates: list[tuple[str, dict]], ranked_ids: list[str],
                       limit: int, category: Optional[str], viewer_uid: str,
                       window: int = CANDIDATE_WINDOW) -> FeedPage:
    """Assemble a For You page from ranked candidate ids.

    Pagination advances by candidate *window*, not by ranked position: the
    next cursor points past the oldest candidate this window considered, so
    windows are disjoint and a post can never appear on two pages.
    """
    by_id = {doc_id: data for doc_id, data in candidates}
    considered = candidates[:window]
    more_available = len(candidates) > window

    ordered = [pid for pid in ranked_ids if pid in by_id][:limit]
    posts = [serialize_post(pid, by_id[pid], viewer_uid) for pid in ordered]

    next_cursor = None
    if considered and more_available:
        last_id, last_data = considered[-1]
        created = _to_utc(last_data.get("createdAt"))
        if created:
            next_cursor = encode_cursor(created, last_id, MODE_FOR_YOU, category)

    return FeedPage(
        posts=posts,
        next_cursor=next_cursor,
        has_more=bool(next_cursor),
        candidates_considered=len(considered),
        queries_issued=1,
    )


def get_following_ids(db, uid: str, limit: int = MAX_FOLLOW_SCAN) -> list[str]:
    """Every author this user follows, up to MAX_FOLLOW_SCAN."""
    try:
        docs = (
            db.collection("follows")
            .where(filter=gcf.FieldFilter("followerId", "==", uid))
            .limit(limit)
            .stream()
        )
        return [d.to_dict().get("followingId") for d in docs if (d.to_dict() or {}).get("followingId")]
    except Exception:
        log.exception("Could not load following list for uid=%s", uid)
        return []


def select_followed_authors(
    following_ids: list[str],
    uid: str,
    day: Optional[str] = None,
) -> tuple[list[str], bool]:
    """Pick which followed authors a Following page queries.

    Firestore caps `in` filters at 10 values and we cap the fan-out at
    MAX_FOLLOW_CHUNKS queries, so at most MAX_FOLLOWED_AUTHORS authors can be
    queried for one page. Beyond that the set is *sampled*, never silently
    truncated:

      * deterministic for a given (user, day), so pagination within a session
        is stable and repeatable
      * the window rotates daily, so authors outside a given slice are not
        permanently invisible
      * the caller is told sampling happened and surfaces it in the response

    Tradeoff: a user following more than MAX_FOLLOWED_AUTHORS accounts sees a
    rotating subset on any given day rather than a strict merge of all of
    them. A true full merge needs either fan-out proportional to the follow
    count or a precomputed per-user timeline - the natural later upgrade.
    """
    unique = sorted({author for author in following_ids if author})
    if len(unique) <= MAX_FOLLOWED_AUTHORS:
        return unique, False

    stamp = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    digest = hashlib.sha256(f"{uid}:{stamp}".encode("utf-8")).digest()
    offset = int.from_bytes(digest[:8], "big") % len(unique)
    rotated = unique[offset:] + unique[:offset]
    return rotated[:MAX_FOLLOWED_AUTHORS], True


LIKES_SUBCOLLECTION = "likes"


def attach_liked_by_me(db, posts: list[dict], viewer_uid: str) -> list[dict]:
    """Fill in likedByMe from posts/{id}/likes/{uid}.

    One batched multi-get for the whole page: page-size document reads in a
    single round trip, rather than a query per post.

    This is the ONLY source of truth for whether the viewer liked a post. The
    legacy likedBy array is deliberately not consulted - see serialize_post
    for why a fallback there would be permanently wrong rather than helpfully
    transitional.
    """
    if not posts or not viewer_uid:
        return posts

    refs = [
        db.collection("posts").document(post["id"])
        .collection(LIKES_SUBCOLLECTION).document(viewer_uid)
        for post in posts if post.get("id")
    ]
    if not refs:
        return posts

    liked_ids: set[str] = set()
    try:
        for snapshot in db.get_all(refs):
            if snapshot.exists:
                # .parent is the likes collection; its parent is the post.
                liked_ids.add(snapshot.reference.parent.parent.id)
    except Exception:
        log.exception("Could not resolve like state for the viewer")
        return posts

    for post in posts:
        if post.get("id") in liked_ids:
            post["likedByMe"] = True
    return posts
