# style_vectors.py
"""Post style vectors and taste similarity.

A post carries rich but messy signals: a category, a free-text aesthetic, a
score map, model-written tags, detected garments and a colour palette. This
module turns those into a small, typed, versioned vector over a *bounded*
vocabulary, so the feature space cannot grow with whatever the model happens
to emit.

Design constraints:
  * bounded vocabulary - unknown values map to a canonical bucket or are
    dropped, never given a new dimension
  * deterministic - same post in, same vector out
  * legacy tolerant - posts with only a category still produce a usable vector
  * no external vector store; these are a few dozen floats computed on demand
"""

from __future__ import annotations

import math
import re
from typing import Any, Optional

STYLE_VECTOR_VERSION = 1

# Canonical aesthetic dimensions: the app's ten categories plus the extra
# aesthetics the analysis prompt is allowed to return.
CANONICAL_AESTHETICS = (
    "streetwear", "alternative", "preppy", "western", "vintage",
    "minimalist", "y2k", "business casual", "athleisure", "cottagecore",
    "gorpcore", "dark academia",
)
_AESTHETIC_SET = set(CANONICAL_AESTHETICS)

# Aliases seen in model output mapped onto canonical dimensions.
AESTHETIC_ALIASES = {
    "street wear": "streetwear", "street": "streetwear", "urban": "streetwear",
    "skate": "streetwear", "hypebeast": "streetwear",
    "alt": "alternative", "grunge": "alternative", "punk": "alternative",
    "goth": "alternative", "emo": "alternative",
    "retro": "vintage", "thrifted": "vintage", "secondhand": "vintage",
    "2000s": "y2k", "y2k revival": "y2k",
    "minimal": "minimalist", "clean": "minimalist", "normcore": "minimalist",
    "business": "business casual", "workwear": "business casual",
    "office": "business casual", "smart casual": "business casual",
    "athletic": "athleisure", "sporty": "athleisure", "gym": "athleisure",
    "cottage core": "cottagecore", "coquette": "cottagecore",
    "romantic": "cottagecore", "prairie": "cottagecore",
    "ivy": "preppy", "collegiate": "preppy", "prep": "preppy",
    "cowboy": "western", "rodeo": "western",
    "outdoor": "gorpcore", "hiking": "gorpcore", "technical": "gorpcore",
    "academia": "dark academia", "darkacademia": "dark academia",
}

# Garment buckets: detected items are noisy free text, so they collapse into
# a small set of slots rather than becoming one dimension per phrase.
GARMENT_BUCKETS = {
    "outerwear": ("jacket", "coat", "blazer", "parka", "windbreaker", "trench", "bomber", "cardigan", "hoodie"),
    "top": ("shirt", "tee", "t shirt", "top", "blouse", "sweater", "knit", "jumper", "turtleneck", "polo"),
    "bottom": ("jeans", "trousers", "pants", "shorts", "skirt", "chinos", "cargo", "leggings"),
    "dress": ("dress", "gown", "jumpsuit", "romper"),
    "footwear": ("sneakers", "boots", "shoes", "loafers", "heels", "sandals", "trainers"),
    "accessory": ("bag", "hat", "cap", "scarf", "belt", "sunglasses", "jewelry", "watch", "necklace", "beanie"),
}

# Colour families keyed by hue; keeps palettes to a handful of dimensions.
COLOR_FAMILIES = ("neutral", "black", "white", "red", "orange", "yellow",
                  "green", "blue", "purple", "pink", "brown")

_TAG_CLEAN = re.compile(r"[^a-z0-9 ]+")
MAX_TAG_DIMENSIONS = 12


def _clean_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return _TAG_CLEAN.sub(" ", value.strip().lower()).strip()


def canonical_aesthetic(value: Any) -> Optional[str]:
    """Map free text onto a canonical aesthetic, or None."""
    text = _clean_text(value)
    if not text:
        return None
    if text in _AESTHETIC_SET:
        return text
    if text in AESTHETIC_ALIASES:
        return AESTHETIC_ALIASES[text]
    # A multi-word phrase may still contain a canonical name.
    for name in CANONICAL_AESTHETICS:
        if name in text:
            return name
    for alias, target in AESTHETIC_ALIASES.items():
        if alias in text:
            return target
    return None


def canonical_garment(value: Any) -> Optional[str]:
    """Bucket a garment phrase. Matches whole words only: a substring match
    would file "capacitor" under accessories because of "cap"."""
    text = _clean_text(value)
    if not text:
        return None
    words = set(text.split())
    for bucket, keywords in GARMENT_BUCKETS.items():
        for keyword in keywords:
            if " " in keyword:
                if keyword in text:
                    return bucket
            elif keyword in words:
                return bucket
    return None


def color_family(hex_value: Any) -> Optional[str]:
    """Bucket a hex colour into a coarse family."""
    if not isinstance(hex_value, str):
        return None
    text = hex_value.strip().lstrip("#")
    if len(text) != 6:
        return None
    try:
        r, g, b = (int(text[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None

    high, low = max(r, g, b), min(r, g, b)
    brightness = (r * 299 + g * 587 + b * 114) / 1000
    saturation = (high - low) / high if high else 0.0

    if brightness < 40:
        return "black"
    if brightness > 225 and saturation < 0.12:
        return "white"
    if saturation < 0.18:
        return "neutral"
    if high == r and g > b and (g - b) > 30 and r > 120 and g > 60 and b < 120:
        return "brown" if brightness < 140 else "orange"
    if high == r:
        return "pink" if b > g and (b - g) > 25 else "red"
    if high == g:
        return "green"
    if high == b:
        return "purple" if r > g and (r - g) > 25 else "blue"
    if r > 180 and g > 180 and b < 120:
        return "yellow"
    return "neutral"


def _normalize_map(values: dict[str, float]) -> dict[str, float]:
    """Scale to [0,1] by the largest entry, dropping negligible weights."""
    cleaned = {
        key: float(value)
        for key, value in values.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        and math.isfinite(float(value)) and float(value) > 0
    }
    if not cleaned:
        return {}
    peak = max(cleaned.values())
    if peak <= 0:
        return {}
    return {
        key: round(min(value / peak, 1.0), 4)
        for key, value in cleaned.items()
        if value / peak >= 0.05
    }


def post_style_vector(post: dict) -> dict:
    """Typed, versioned style representation for a post.

    Falls back cleanly for legacy posts: a post with nothing but a category
    still yields a usable single-dimension aesthetic vector.
    """
    aesthetics: dict[str, float] = {}

    # Strongest signal: the model's per-aesthetic scores.
    scores = post.get("aestheticScores")
    if isinstance(scores, dict):
        for key, value in scores.items():
            canonical = canonical_aesthetic(key)
            if not canonical:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            weight = float(value)
            if not math.isfinite(weight) or weight <= 0:
                continue
            if weight > 1:  # tolerate percentages
                weight = weight / 100 if weight <= 100 else 1.0
            aesthetics[canonical] = max(aesthetics.get(canonical, 0.0), min(weight, 1.0))

    # The single labelled aesthetic, and the author's chosen category.
    primary = canonical_aesthetic(post.get("aesthetic"))
    if primary:
        aesthetics[primary] = max(aesthetics.get(primary, 0.0), 0.9)

    category = canonical_aesthetic(post.get("category"))
    if category:
        aesthetics[category] = max(aesthetics.get(category, 0.0), 0.7)

    # Tags can also name aesthetics.
    tags: dict[str, float] = {}
    raw_tags = post.get("aestheticTags")
    if isinstance(raw_tags, list):
        for tag in raw_tags[:MAX_TAG_DIMENSIONS]:
            text = _clean_text(tag)
            if not text or len(text) > 40:
                continue
            tags[text] = 1.0
            canonical = canonical_aesthetic(text)
            if canonical:
                aesthetics[canonical] = max(aesthetics.get(canonical, 0.0), 0.5)

    items: dict[str, float] = {}
    raw_items = post.get("detectedItems")
    if isinstance(raw_items, list):
        for item in raw_items[:20]:
            bucket = canonical_garment(item)
            if bucket:
                items[bucket] = items.get(bucket, 0.0) + 1.0

    colors: dict[str, float] = {}
    palette = post.get("palette")
    if isinstance(palette, list):
        for entry in palette[:8]:
            hex_value = entry if isinstance(entry, str) else (
                entry.get("hex") if isinstance(entry, dict) else None
            )
            family = color_family(hex_value)
            if not family:
                continue
            share = 1.0
            if isinstance(entry, dict):
                pct = entry.get("percentage")
                if isinstance(pct, (int, float)) and not isinstance(pct, bool) and pct > 0:
                    share = min(float(pct) / 100.0, 1.0)
            colors[family] = colors.get(family, 0.0) + share

    return {
        "version": STYLE_VECTOR_VERSION,
        "aesthetics": _normalize_map(aesthetics),
        "tags": _normalize_map(tags),
        "items": _normalize_map(items),
        "colors": _normalize_map(colors),
    }


# ------------------------------------------------------------- similarity

# Facet weights for the blended similarity. Aesthetics dominate because they
# are what "style" means here; colour is a weak secondary cue.
FACET_WEIGHTS = {"aesthetics": 0.65, "tags": 0.15, "items": 0.05, "colors": 0.15}


def cosine_similarity(a: dict[str, float], b: dict[str, float]) -> float:
    """Cosine similarity over sparse non-negative maps, bounded [0,1]."""
    if not a or not b:
        return 0.0
    shared = set(a) & set(b)
    if not shared:
        return 0.0
    dot = sum(float(a[k]) * float(b[k]) for k in shared)
    norm_a = math.sqrt(sum(float(v) ** 2 for v in a.values()))
    norm_b = math.sqrt(sum(float(v) ** 2 for v in b.values()))
    if norm_a <= 0 or norm_b <= 0:
        return 0.0
    value = dot / (norm_a * norm_b)
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(value, 1.0))


def style_similarity(taste: Optional[dict], post_vector: Optional[dict]) -> float:
    """Blended similarity between a taste profile and a post, in [0,1].

    Returns a neutral 0.0 when either side is missing or empty, so a cold-start
    user simply gets no personalisation contribution rather than a NaN or a
    misleading score.
    """
    if not isinstance(taste, dict) or not isinstance(post_vector, dict):
        return 0.0

    total = 0.0
    used_weight = 0.0
    for facet, weight in FACET_WEIGHTS.items():
        taste_facet = taste.get(facet)
        post_facet = post_vector.get(facet)
        if not isinstance(taste_facet, dict) or not isinstance(post_facet, dict):
            continue
        if not taste_facet or not post_facet:
            continue
        total += weight * cosine_similarity(taste_facet, post_facet)
        used_weight += weight

    if used_weight <= 0:
        return 0.0
    # Renormalise so a post with only some facets is not penalised for the
    # facets it lacks.
    value = total / used_weight
    return max(0.0, min(value, 1.0))
