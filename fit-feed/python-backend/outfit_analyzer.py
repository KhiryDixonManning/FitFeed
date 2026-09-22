# outfit_analyzer.py
"""Outfit analysis: local colour extraction plus Claude multimodal analysis.

The analyser is handed raw image bytes that the caller has already fetched
through image_fetch (trusted host, size- and content-checked). Model output is
run through validation.validate_analysis_output before it is returned, so a
malformed or surprising response degrades to the locally computed palette
instead of writing junk into Firestore.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from io import BytesIO
from pathlib import Path

import anthropic
import numpy as np
from dotenv import load_dotenv
from PIL import Image
from sklearn.cluster import KMeans

from validation import validate_analysis_output

log = logging.getLogger(__name__)

_here = Path(__file__).resolve().parent
load_dotenv(dotenv_path=_here / ".env", override=False)

# Dateless model IDs (4.6 generation onward) are pinned snapshots and can be
# retired eventually - if analysis starts failing with a model 404, check
# https://platform.claude.com/docs/en/about-claude/models/overview
CLAUDE_MODEL = "claude-sonnet-5"

# Presence only - never log any part of the key itself.
if not os.getenv("ANTHROPIC_API_KEY"):
    log.warning("ANTHROPIC_API_KEY is not configured; Claude analysis will be skipped")

ANALYSIS_PROMPT = """Analyze this outfit photo. Return ONLY a valid JSON object with no extra text, no markdown, no backticks, no explanation. Use exactly this structure:
{
  "aesthetic": "one of: streetwear, vintage, y2k, minimalist, cottagecore, preppy, western, alternative, athleisure, business casual, gorpcore, dark academia, other",
  "aestheticTags": ["tag1", "tag2", "tag3"],
  "detectedItems": ["item1", "item2", "item3"],
  "outfitName": "A 3-5 word poetic evocative name for this specific outfit that captures its energy and vibe. Like a song title or album name. Examples: Red Static Against the Concrete, Archive of Quiet Observations, Borrowed Light in Motion, Soft Chaos Theory. Make it specific to THIS outfit not generic.",
  "styleDescription": "Exactly 2 sentences describing this look and how to articulate it.",
  "styleNotes": "3-4 sentences of deeper analysis about the aesthetic composition, cultural references, and what makes this outfit work. Be specific and insightful like a fashion editor.",
  "aestheticScores": {
    "streetwear": 0.0,
    "vintage": 0.0,
    "minimalist": 0.0,
    "y2k": 0.0,
    "alternative": 0.0
  },
  "colors": [
    {"hex": "#1A1A1A", "name": "Metropolis", "percentage": 61},
    {"hex": "#D0312D", "name": "Red", "percentage": 25},
    {"hex": "#FFFFFF", "name": "White", "percentage": 7}
  ]
}
For colors: analyze ONLY the clothing and accessories being worn. Ignore background walls, floors, mirrors, furniture, shelving, other people, and any objects not being worn by the subject. Provide exactly 3 dominant colors from the OUTFIT ITSELF with a creative fashion-forward name (like Metropolis, Ivory, Slate, Rust, Sage, Camel, Cobalt, Onyx — not just basic color names), the hex code, and the percentage of the OUTFIT that color occupies."""


def extract_color_palette_from_bytes(image_bytes: bytes, n_colors: int = 5) -> list:
    """Dominant colours via KMeans over the centre crop. Never raises."""
    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")

        # Crop to the centre so background walls/floors matter less.
        width, height = img.size
        img = img.crop((int(width * 0.2), int(height * 0.1), int(width * 0.8), int(height * 0.9)))
        img = img.resize((150, 150))
        pixels = np.array(img).reshape(-1, 3)

        kmeans = KMeans(n_clusters=n_colors, random_state=42, n_init=10)
        kmeans.fit(pixels)

        return [
            "#{:02x}{:02x}{:02x}".format(*[int(c) for c in center])
            for center in kmeans.cluster_centers_
        ]
    except Exception:
        log.exception("Local colour extraction failed")
        return []


def _extract_json(raw_text: str) -> str:
    """Strip markdown fences the model may add despite instructions."""
    text = raw_text.strip()
    if text.startswith("```"):
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1]
            if text.startswith("json"):
                text = text[4:]
    return text.strip()


def analyze_outfit_with_claude_bytes(image_bytes: bytes) -> dict:
    """Send the image to Claude and return validated analysis fields.

    Returns {} on any failure so the caller can fall back cleanly.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        log.warning("Skipping Claude analysis: no API key configured")
        return {}

    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        max_size = 1024
        ratio = min(max_size / img.width, max_size / img.height, 1.0)
        if ratio < 1.0:
            img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)

        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=85)
        buffer.seek(0)
        image_data = base64.standard_b64encode(buffer.read()).decode("utf-8")

        client = anthropic.Anthropic()
        message = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg", "data": image_data},
                    },
                    {"type": "text", "text": ANALYSIS_PROMPT},
                ],
            }],
        )

        raw = _extract_json(message.content[0].text)
        parsed = json.loads(raw)

        # Model output is untrusted input: coerce it into the known schema.
        validated = validate_analysis_output(parsed)
        if validated is None:
            log.warning("Claude response contained no usable fields after validation")
            return {}

        log.info(
            "Claude analysis ok: aesthetic=%s tags=%d items=%d colors=%d",
            validated.get("aesthetic"),
            len(validated.get("aestheticTags", [])),
            len(validated.get("detectedItems", [])),
            len(validated.get("colors", [])),
        )
        return validated

    except anthropic.NotFoundError as exc:
        # A 404 from the Messages API means the model id no longer exists.
        # This exact failure mode silently broke analysis once (retired
        # claude-sonnet-4-20250514) - make it unmissable in the logs.
        log.error(
            "MODEL RETIRED OR INVALID: %s - update CLAUDE_MODEL in outfit_analyzer.py "
            "(see platform.claude.com/docs/en/about-claude/models/overview). API said: %s",
            CLAUDE_MODEL, exc,
        )
        return {}
    except json.JSONDecodeError:
        # Log that parsing failed and how much text came back, not the text.
        log.warning("Claude returned text that is not valid JSON")
        return {}
    except Exception:
        log.exception("Claude analysis failed")
        return {}


def analyze_image_bytes(image_bytes: bytes) -> dict:
    """Analyse already-fetched image bytes. Always returns a result dict."""
    result = {
        "palette": [],
        "aesthetic": None,
        "outfitName": None,
        "aestheticTags": [],
        "detectedItems": [],
        "styleDescription": None,
        "styleNotes": None,
        "aestheticScores": {},
        "analyzed": False,
    }

    kmeans_palette = extract_color_palette_from_bytes(image_bytes)
    claude_result = analyze_outfit_with_claude_bytes(image_bytes)

    if claude_result:
        # Prefer Claude's named colours; fall back to the KMeans hex list.
        result["palette"] = claude_result.get("colors") or kmeans_palette
        result["aesthetic"] = claude_result.get("aesthetic")
        result["outfitName"] = claude_result.get("outfitName")
        result["aestheticTags"] = claude_result.get("aestheticTags", [])
        result["detectedItems"] = claude_result.get("detectedItems", [])
        result["styleDescription"] = claude_result.get("styleDescription")
        result["styleNotes"] = claude_result.get("styleNotes")
        result["aestheticScores"] = claude_result.get("aestheticScores", {})
        result["analyzed"] = True
    else:
        result["palette"] = kmeans_palette
        log.info("Falling back to locally extracted palette only")

    return result
