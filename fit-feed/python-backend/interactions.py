# interactions.py
"""Interaction signals used to learn taste.

Scope is deliberately narrow: these are *recommendation* signals, not
analytics. Nothing about the device, browser, IP, referrer or session is
stored, and nothing is recorded for a user other than the one acting.

Schema
------
    users/{uid}/interactions/{type}_{postId}

        postId         string
        type           impression | view | more_like_this | not_interested
        createdAt      ISO string
        value          optional bounded bucket (dwell only)
        schemaVersion  int

The document id is derived from (type, postId), which makes every write
idempotent: a post can contribute at most one impression and one view per
user, no matter how many times it scrolls past. That caps both storage and
the influence any single post can have, and it means the client can retry
freely without inflating anything.

Likes, comments and saves are NOT duplicated here - they already have their
own collections, which remain the source of truth.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

log = logging.getLogger(__name__)

INTERACTION_SCHEMA_VERSION = 1
INTERACTIONS_SUBCOLLECTION = "interactions"

# Weak, passive signals (recorded automatically by the UI).
TYPE_IMPRESSION = "impression"
TYPE_VIEW = "view"
# Explicit, deliberate signals (a button press).
TYPE_MORE_LIKE_THIS = "more_like_this"
TYPE_NOT_INTERESTED = "not_interested"

INTERACTION_TYPES = (TYPE_IMPRESSION, TYPE_VIEW, TYPE_MORE_LIKE_THIS, TYPE_NOT_INTERESTED)

# Explicit feedback is mutually exclusive: asking for more of something and
# marking it uninteresting cannot both be true.
OPPOSING_TYPES = {
    TYPE_MORE_LIKE_THIS: TYPE_NOT_INTERESTED,
    TYPE_NOT_INTERESTED: TYPE_MORE_LIKE_THIS,
}

# Dwell is stored as a coarse bucket, never a precise duration: the product
# only needs "did this hold attention", and exact timings are behavioural
# detail we have no reason to keep.
DWELL_BUCKETS = ("short", "meaningful", "long")

MAX_POST_ID_LEN = 200
_DOC_ID_SAFE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")

# Bound how much history a taste rebuild will read.
MAX_INTERACTIONS_SCANNED = 400
MAX_NOT_INTERESTED_SCANNED = 200


def interaction_doc_id(interaction_type: str, post_id: str) -> str:
    """Deterministic id: one document per (type, post) per user."""
    return f"{interaction_type}_{post_id}"


def is_valid_post_id(post_id: Any) -> bool:
    return (
        isinstance(post_id, str)
        and 0 < len(post_id) <= MAX_POST_ID_LEN
        and bool(_DOC_ID_SAFE.match(post_id))
    )


def normalize_dwell_bucket(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    bucket = value.strip().lower()
    return bucket if bucket in DWELL_BUCKETS else None


def fetch_interactions(db, uid: str, limit: int = MAX_INTERACTIONS_SCANNED) -> list[dict]:
    """Recent interaction documents for one user (bounded)."""
    try:
        docs = (
            db.collection("users").document(uid)
            .collection(INTERACTIONS_SUBCOLLECTION)
            .limit(limit)
            .stream()
        )
        return [d.to_dict() or {} for d in docs]
    except Exception:
        log.exception("Could not read interactions for uid=%s", uid)
        return []


def fetch_not_interested_ids(db, uid: str, limit: int = MAX_NOT_INTERESTED_SCANNED) -> set[str]:
    """Post ids this user asked not to see again.

    Used to filter feed candidates. Bounded, so a user who hides an enormous
    number of posts simply stops adding to the filter rather than making
    every feed request more expensive.
    """
    try:
        from google.cloud import firestore as gcf

        docs = (
            db.collection("users").document(uid)
            .collection(INTERACTIONS_SUBCOLLECTION)
            .where(filter=gcf.FieldFilter("type", "==", TYPE_NOT_INTERESTED))
            .limit(limit)
            .stream()
        )
        ids = set()
        for doc in docs:
            post_id = (doc.to_dict() or {}).get("postId")
            if is_valid_post_id(post_id):
                ids.add(post_id)
        return ids
    except Exception:
        log.exception("Could not read hidden posts for uid=%s", uid)
        return set()
