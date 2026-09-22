# validation.py
"""Request and model-output validation.

Two distinct trust boundaries are handled here:

1. Request bodies from the browser - bounded in size and shape so a caller
   cannot make the service do unbounded work.
2. Output from the Claude API - a language model returns free-form JSON, so it
   is treated as untrusted input and coerced into a known schema before any of
   it reaches Firestore or the UI.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Optional

# ---------------------------------------------------------------- constants

# Categories the app offers, plus the extra aesthetics the analysis prompt
# allows the model to choose from.
APP_CATEGORIES = [
    "streetwear", "alternative", "preppy", "western", "vintage",
    "minimalist", "y2k", "business casual", "athleisure", "cottagecore",
]
EXTRA_AESTHETICS = ["gorpcore", "dark academia", "other"]
ALLOWED_AESTHETICS = set(APP_CATEGORIES) | set(EXTRA_AESTHETICS)

MAX_RANK_POSTS = 200          # ranking is O(n log n) plus per-post work
MAX_TRENDING_POSTS = 200
MAX_POST_ID_LEN = 200

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

# Output caps - a model can return arbitrarily long strings/lists.
MAX_OUTFIT_NAME = 120
MAX_STYLE_DESCRIPTION = 800
MAX_STYLE_NOTES = 1500
MAX_TAGS = 8
MAX_TAG_LEN = 40
MAX_ITEMS = 12
MAX_ITEM_LEN = 60
MAX_COLORS = 5
MAX_COLOR_NAME = 40
MAX_SCORES = 12


class ValidationError(Exception):
    """Raised when a client request cannot be processed as sent."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ------------------------------------------------------------ request input

def require_json_object(data: Any) -> dict:
    """Body must be a JSON object (Flask gives None for absent/invalid JSON)."""
    if data is None:
        raise ValidationError("Request body must be JSON.")
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object.")
    return data


def require_string(data: dict, field: str, max_len: int, *, required: bool = True) -> Optional[str]:
    value = data.get(field)
    if value is None:
        if required:
            raise ValidationError(f"Missing required field: {field}.")
        return None
    if not isinstance(value, str):
        raise ValidationError(f"Field {field} must be a string.")
    value = value.strip()
    if required and not value:
        raise ValidationError(f"Field {field} must not be empty.")
    if len(value) > max_len:
        raise ValidationError(f"Field {field} exceeds the maximum length of {max_len}.")
    return value


def require_post_id(data: dict, field: str = "postId") -> str:
    post_id = require_string(data, field, MAX_POST_ID_LEN)
    assert post_id is not None
    # Firestore document ids cannot contain slashes and are never path traversal.
    if "/" in post_id or post_id in (".", ".."):
        raise ValidationError(f"Field {field} is not a valid document id.")
    return post_id


def validate_posts_payload(data: dict, max_posts: int, field: str = "posts") -> list[dict]:
    """Bound the size and shape of a client-supplied post list.

    Entries are kept as-is (the ranking engine tolerates missing fields) but
    each must be an object, and the list length is capped so one request cannot
    ask the service to rank an unbounded amount of data.
    """
    posts = data.get(field, [])
    if posts is None:
        posts = []
    if not isinstance(posts, list):
        raise ValidationError(f"Field {field} must be a list.")
    if len(posts) > max_posts:
        raise ValidationError(
            f"Too many posts: {len(posts)} sent, maximum is {max_posts}.",
            status=413,
        )

    cleaned: list[dict] = []
    for index, post in enumerate(posts):
        if not isinstance(post, dict):
            raise ValidationError(f"Entry {index} in {field} must be an object.")
        cleaned.append(post)
    return cleaned


def validate_preferences(raw: Any) -> dict[str, float]:
    """Coerce a stored preference map into {category: finite float}."""
    if not isinstance(raw, dict):
        return {}
    prefs: dict[str, float] = {}
    for key, value in list(raw.items())[:50]:
        if not isinstance(key, str):
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not math.isfinite(float(value)):
            continue
        prefs[key] = float(value)
    return prefs


# -------------------------------------------------------- model output schema

def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _coerce_number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number


def _clean_string_list(value: Any, max_items: int, max_len: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for entry in value:
        if not isinstance(entry, str):
            continue
        text = entry.strip()
        if not text:
            continue
        out.append(text[:max_len])
        if len(out) >= max_items:
            break
    return out


def _clean_colors(value: Any) -> list[dict]:
    """Colours must be valid 6-digit hex with a bounded name and 0-100 percent."""
    if not isinstance(value, list):
        return []
    colors: list[dict] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        hex_value = entry.get("hex")
        if not isinstance(hex_value, str) or not HEX_COLOR.match(hex_value.strip()):
            continue
        name = entry.get("name")
        name = name.strip()[:MAX_COLOR_NAME] if isinstance(name, str) and name.strip() else "Unknown"
        percentage = _coerce_number(entry.get("percentage"))
        colors.append({
            "hex": hex_value.strip().upper(),
            "name": name,
            "percentage": int(round(_clamp(percentage, 0, 100))) if percentage is not None else 0,
        })
        if len(colors) >= MAX_COLORS:
            break
    return colors


def _clean_scores(value: Any) -> dict[str, float]:
    """Aesthetic scores: known aesthetics only, clamped to 0..1."""
    if not isinstance(value, dict):
        return {}
    scores: dict[str, float] = {}
    for key, raw in value.items():
        if not isinstance(key, str):
            continue
        label = key.strip().lower()
        if label not in ALLOWED_AESTHETICS:
            continue
        number = _coerce_number(raw)
        if number is None:
            continue
        # Tolerate a model that answers in percent.
        if number > 1:
            number = number / 100 if number <= 100 else 1.0
        scores[label] = round(_clamp(number, 0.0, 1.0), 4)
        if len(scores) >= MAX_SCORES:
            break
    return scores


def validate_analysis_output(raw: Any) -> Optional[dict]:
    """Coerce raw Claude JSON into the stored analysis schema.

    Returns None when the payload is unusable, so the caller can fall back to
    the locally computed colour palette instead of writing model noise into
    Firestore. Individual bad fields are dropped rather than failing the whole
    analysis.
    """
    if not isinstance(raw, dict):
        return None

    aesthetic = raw.get("aesthetic")
    if isinstance(aesthetic, str) and aesthetic.strip().lower() in ALLOWED_AESTHETICS:
        aesthetic = aesthetic.strip().lower()
    else:
        aesthetic = None

    outfit_name = raw.get("outfitName")
    outfit_name = outfit_name.strip()[:MAX_OUTFIT_NAME] if isinstance(outfit_name, str) and outfit_name.strip() else None

    style_description = raw.get("styleDescription")
    style_description = (
        style_description.strip()[:MAX_STYLE_DESCRIPTION]
        if isinstance(style_description, str) and style_description.strip() else None
    )

    style_notes = raw.get("styleNotes")
    style_notes = (
        style_notes.strip()[:MAX_STYLE_NOTES]
        if isinstance(style_notes, str) and style_notes.strip() else None
    )

    cleaned = {
        "aesthetic": aesthetic,
        "outfitName": outfit_name,
        "styleDescription": style_description,
        "styleNotes": style_notes,
        "aestheticTags": _clean_string_list(raw.get("aestheticTags"), MAX_TAGS, MAX_TAG_LEN),
        "detectedItems": _clean_string_list(raw.get("detectedItems"), MAX_ITEMS, MAX_ITEM_LEN),
        "aestheticScores": _clean_scores(raw.get("aestheticScores")),
        "colors": _clean_colors(raw.get("colors")),
    }

    # If nothing survived validation there is no analysis worth storing.
    has_signal = any([
        cleaned["aesthetic"], cleaned["outfitName"], cleaned["styleDescription"],
        cleaned["styleNotes"], cleaned["aestheticTags"], cleaned["detectedItems"],
        cleaned["aestheticScores"], cleaned["colors"],
    ])
    return cleaned if has_signal else None


# ------------------------------------------------------------- feed requests

FEED_MODES = ("foryou", "discover", "following")
DEFAULT_FEED_LIMIT = 20
MAX_FEED_LIMIT = 30
MAX_CURSOR_CHARS = 512


@dataclass(frozen=True)
class FeedRequest:
    mode: str
    limit: int
    category: Optional[str]
    cursor: Optional[str]


def require_feed_request(data: dict) -> FeedRequest:
    """Validate everything the client is allowed to influence about a page.

    The client may choose a mode, a page size within bounds, a category from
    the known list, and echo back a cursor. It may not send posts, counts,
    preferences, uids or ordering.
    """
    mode = data.get("mode", "foryou")
    if not isinstance(mode, str) or mode not in FEED_MODES:
        raise ValidationError(f"mode must be one of: {', '.join(FEED_MODES)}.")

    raw_limit = data.get("limit", DEFAULT_FEED_LIMIT)
    if raw_limit is None:
        raw_limit = DEFAULT_FEED_LIMIT
    if isinstance(raw_limit, bool) or not isinstance(raw_limit, int):
        raise ValidationError("limit must be an integer.")
    if raw_limit < 1:
        raise ValidationError("limit must be at least 1.")
    limit = min(raw_limit, MAX_FEED_LIMIT)

    category = data.get("category")
    if category in (None, "", "all"):
        category = None
    else:
        if not isinstance(category, str):
            raise ValidationError("category must be a string.")
        category = category.strip().lower()
        if category not in APP_CATEGORIES:
            raise ValidationError("category is not a known category.")

    cursor = data.get("cursor")
    if cursor in (None, ""):
        cursor = None
    elif not isinstance(cursor, str):
        raise ValidationError("cursor must be a string.")
    elif len(cursor) > MAX_CURSOR_CHARS:
        raise ValidationError("cursor is too long.")

    # Reject authoritative data the client must no longer supply, rather than
    # silently ignoring it - a caller sending these has the wrong contract.
    for forbidden in ("posts", "userPreferences", "uid", "likesCount", "commentsCount"):
        if forbidden in data:
            raise ValidationError(
                f"{forbidden} is not accepted; the server derives feed data itself."
            )

    return FeedRequest(mode=mode, limit=limit, category=category, cursor=cursor)


# -------------------------------------------------------- interaction signals

INTERACTION_TYPES = ("impression", "view", "more_like_this", "not_interested")
DWELL_BUCKETS = ("short", "meaningful", "long")


@dataclass(frozen=True)
class InteractionRequest:
    post_id: str
    type: str
    value: Optional[str]


def require_interaction(data: dict) -> InteractionRequest:
    """Validate a recommendation signal.

    The caller may say which post and which signal, and optionally a coarse
    dwell bucket. It may not supply a uid, a timestamp, a weight, or a free
    numeric duration - identity comes from the token and the server stamps
    the time.
    """
    post_id = require_post_id(data)

    interaction_type = data.get("type")
    if not isinstance(interaction_type, str) or interaction_type not in INTERACTION_TYPES:
        raise ValidationError(f"type must be one of: {', '.join(INTERACTION_TYPES)}.")

    value = data.get("value")
    if value in (None, ""):
        value = None
    else:
        if not isinstance(value, str):
            raise ValidationError("value must be a string bucket.")
        value = value.strip().lower()
        if value not in DWELL_BUCKETS:
            raise ValidationError(f"value must be one of: {', '.join(DWELL_BUCKETS)}.")
    if value and interaction_type != "view":
        raise ValidationError("value is only meaningful for a view signal.")

    for forbidden in ("uid", "userId", "weight", "createdAt", "schemaVersion", "durationMs"):
        if forbidden in data:
            raise ValidationError(f"{forbidden} is not accepted on an interaction.")

    return InteractionRequest(post_id=post_id, type=interaction_type, value=value)
