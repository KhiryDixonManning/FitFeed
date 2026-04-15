# outfit_analyzer.py

import os
import base64
import json
import requests
import numpy as np
import anthropic
from PIL import Image
from sklearn.cluster import KMeans
from io import BytesIO
from pathlib import Path
from dotenv import load_dotenv

_here = Path(__file__).resolve().parent
_env_path = _here / ".env"
print(f"[dotenv] Looking for .env at: {_env_path}")
print(f"[dotenv] File exists: {_env_path.exists()}")
load_dotenv(dotenv_path=_env_path, override=True)

api_key = os.getenv("ANTHROPIC_API_KEY")
if not api_key:
    print("WARNING: ANTHROPIC_API_KEY is not set — Claude analysis will fail")
else:
    print(f"ANTHROPIC_API_KEY loaded: {api_key[:8]}...")


def extract_color_palette_from_bytes(image_bytes: bytes, n_colors: int = 5) -> list:
    """
    Extracts dominant colors from raw image bytes using KMeans clustering.
    Crops to center 60% of the image to focus on the outfit, not background.
    Returns list of hex color strings.
    Falls back to empty list on any error.
    """
    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")

        # Crop to center 60% of image to focus on outfit, not background
        width, height = img.size
        left = int(width * 0.2)
        top = int(height * 0.1)
        right = int(width * 0.8)
        bottom = int(height * 0.9)
        img = img.crop((left, top, right, bottom))

        img = img.resize((150, 150))
        pixels = np.array(img).reshape(-1, 3)

        kmeans = KMeans(n_clusters=n_colors, random_state=42, n_init=10)
        kmeans.fit(pixels)

        colors = []
        for center in kmeans.cluster_centers_:
            r, g, b = [int(c) for c in center]
            hex_color = "#{:02x}{:02x}{:02x}".format(r, g, b)
            colors.append(hex_color)

        return colors
    except Exception as e:
        print(f"Color extraction failed: {e}")
        return []


def analyze_outfit_with_claude_bytes(image_bytes: bytes) -> dict:
    """
    Sends raw image bytes to Claude API as base64.
    Resizes and compresses before sending to reduce payload size.
    Returns structured metadata dict. Falls back to empty dict on any error.
    """
    try:
        # Resize and compress before sending to Claude
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        max_size = 1024
        ratio = min(max_size / img.width, max_size / img.height, 1.0)
        if ratio < 1.0:
            new_size = (int(img.width * ratio), int(img.height * ratio))
            img = img.resize(new_size, Image.LANCZOS)

        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=85)
        buffer.seek(0)
        image_data = base64.standard_b64encode(buffer.read()).decode("utf-8")
        media_type = "image/jpeg"

        print(f"[claude] Image prepared, base64 size: {len(image_data)} chars")

        client = anthropic.Anthropic()
        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_data,
                            },
                        },
                        {
                            "type": "text",
                            "text": """Analyze this outfit photo. Return ONLY a valid JSON object with no extra text, no markdown, no backticks, no explanation. Use exactly this structure:
{
  "aesthetic": "one of: streetwear, vintage, y2k, minimalist, cottagecore, preppy, western, alternative, athleisure, business casual, gorpcore, dark academia, other",
  "aestheticTags": ["tag1", "tag2", "tag3"],
  "detectedItems": ["item1", "item2", "item3"],
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
For colors: analyze ONLY the clothing and accessories being worn. Ignore background walls, floors, mirrors, furniture, and objects not being worn. Provide exactly 3 dominant colors from the outfit itself with a creative fashion-forward name (like Metropolis, Ivory, Slate, Rust, Sage, Camel, Cobalt — not just basic color names), the hex code, and the percentage of the OUTFIT (not the whole image) that color occupies."""
                        }
                    ],
                }
            ],
        )

        raw = message.content[0].text.strip()
        # Strip markdown code fences if Claude wrapped the JSON despite instructions
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.rsplit("```", 1)[0].strip()
        print(f"[claude] Raw response: {raw}")
        return json.loads(raw)

    except json.JSONDecodeError as e:
        print(f"Claude returned invalid JSON: {e}")
        return {}
    except Exception as e:
        print(f"Claude analysis failed: {e}")
        return {}


def analyze_post(image_url: str) -> dict:
    """
    Main entry point. Downloads image ONCE and reuses bytes for both
    KMeans color extraction (fallback) and Claude analysis.
    Always returns a dict. Never raises an exception.
    """
    print(f"[analyze_post] Starting analysis for: {image_url}")

    result = {
        "palette": [],
        "aesthetic": None,
        "aestheticTags": [],
        "detectedItems": [],
        "styleDescription": None,
        "styleNotes": None,
        "aestheticScores": {},
        "analyzed": False,
    }

    try:
        # Download image ONCE and reuse for both KMeans and Claude
        print("[analyze_post] Downloading image...")
        img_response = requests.get(image_url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0'
        })
        img_response.raise_for_status()
        image_bytes = img_response.content
        print(f"[analyze_post] Image downloaded: {len(image_bytes)} bytes")

        # Run KMeans on downloaded bytes as fallback palette
        print("[analyze_post] Extracting KMeans palette...")
        kmeans_palette = extract_color_palette_from_bytes(image_bytes)
        print(f"[analyze_post] KMeans palette: {kmeans_palette}")

        # Run Claude analysis using the same downloaded bytes
        print("[analyze_post] Calling Claude API...")
        claude_result = analyze_outfit_with_claude_bytes(image_bytes)
        print(f"[analyze_post] Claude result: {claude_result}")

        if claude_result:
            # Use Claude colors if available (richer format with names and percentages)
            # Fall back to KMeans palette if Claude didn't return colors
            result["palette"] = claude_result.get("colors", kmeans_palette)
            result["aesthetic"] = claude_result.get("aesthetic")
            result["aestheticTags"] = claude_result.get("aestheticTags", [])
            result["detectedItems"] = claude_result.get("detectedItems", [])
            result["styleDescription"] = claude_result.get("styleDescription")
            result["styleNotes"] = claude_result.get("styleNotes")
            result["aestheticScores"] = claude_result.get("aestheticScores", {})
            result["analyzed"] = True
            print("[analyze_post] Analysis complete and analyzed=True")
        else:
            # Fall back to KMeans palette only
            result["palette"] = kmeans_palette
            print("[analyze_post] Claude failed, using KMeans palette only")

    except Exception as e:
        print(f"[analyze_post] FAILED: {e}")

    return result
