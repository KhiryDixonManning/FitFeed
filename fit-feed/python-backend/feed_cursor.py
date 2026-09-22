# feed_cursor.py
"""Opaque pagination cursors for the feed API.

A cursor encodes the position of the last item a page consumed, in the feed's
stable ordering (createdAt DESC, document id as tiebreaker). It is base64url
JSON so the client treats it as opaque, and it is strictly validated and bound
to the mode/category it was issued for, so a tampered cursor cannot be used to
reshape the server's query - only to move the position within a collection the
caller is already allowed to read.

Deliberately not signed: the cursor selects an offset into data the caller can
already read in full, so an HMAC would add key management without adding a
privilege boundary. Validation is what matters, and it is exhaustive here.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

CURSOR_VERSION = 1

# Sanity window for the timestamp carried in a cursor (ms since epoch).
_MIN_TS_MS = 0
_MAX_TS_MS = 4_102_444_800_000  # 2100-01-01

_MAX_CURSOR_CHARS = 512
_MAX_DOC_ID = 200


class CursorError(Exception):
    """Raised when a cursor is malformed, tampered with, or misapplied."""


@dataclass(frozen=True)
class FeedCursor:
    created_at_ms: int
    post_id: str
    mode: str
    category: Optional[str]

    @property
    def created_at(self) -> datetime:
        return datetime.fromtimestamp(self.created_at_ms / 1000, tz=timezone.utc)


def encode_cursor(created_at: datetime, post_id: str, mode: str, category: Optional[str]) -> str:
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    payload = {
        "v": CURSOR_VERSION,
        "t": int(created_at.timestamp() * 1000),
        "i": post_id,
        "m": mode,
        "c": category or "",
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(value: str, expected_mode: str, expected_category: Optional[str]) -> FeedCursor:
    """Parse and validate a cursor, or raise CursorError."""
    if not isinstance(value, str) or not value:
        raise CursorError("Cursor must be a non-empty string.")
    if len(value) > _MAX_CURSOR_CHARS:
        raise CursorError("Cursor is too long.")

    try:
        padding = "=" * (-len(value) % 4)
        raw = base64.urlsafe_b64decode(value + padding)
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise CursorError("Cursor is not decodable.") from exc

    if not isinstance(payload, dict):
        raise CursorError("Cursor payload must be an object.")
    if payload.get("v") != CURSOR_VERSION:
        raise CursorError("Cursor version is not supported.")

    created_at_ms = payload.get("t")
    if isinstance(created_at_ms, bool) or not isinstance(created_at_ms, int):
        raise CursorError("Cursor timestamp is invalid.")
    if not (_MIN_TS_MS <= created_at_ms <= _MAX_TS_MS):
        raise CursorError("Cursor timestamp is out of range.")

    post_id = payload.get("i")
    if not isinstance(post_id, str) or not post_id or len(post_id) > _MAX_DOC_ID:
        raise CursorError("Cursor document id is invalid.")
    if "/" in post_id or post_id in (".", ".."):
        raise CursorError("Cursor document id is invalid.")

    mode = payload.get("m")
    if mode != expected_mode:
        # Prevents carrying a Discover cursor into a Following query, where
        # the underlying ordering and filters differ.
        raise CursorError("Cursor does not belong to this feed mode.")

    category = payload.get("c") or None
    if category != (expected_category or None):
        raise CursorError("Cursor does not belong to this category filter.")

    return FeedCursor(
        created_at_ms=created_at_ms,
        post_id=post_id,
        mode=mode,
        category=category,
    )
