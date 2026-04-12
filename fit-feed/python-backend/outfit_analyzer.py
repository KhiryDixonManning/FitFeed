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


def extract_color_palette(image_url: str, n_colors: int = 5) -> list:
    """
    Downloads image and extracts dominant colors using KMeans clustering.
    Returns list of hex color strings.
    Falls back to empty list on any error.
    """
    try:
        response = requests.get(image_url, timeout=10, headers={'User-Agent': 'Mozilla/5.0'})
        response.raise_for_status()
        img = Image.open(BytesIO(response.content)).convert("RGB")

        # Resize for speed
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


def analyze_outfit_with_claude(image_url: str) -> dict:
    """
    Downloads image and sends to Claude API as base64.
    This bypasses Firebase Storage auth requirements.
    Returns structured metadata dict. Falls back to empty dict on any error.
    """
    try:
        # Download image first and convert to base64
        # This bypasses Firebase Storage auth requirements
        img_response = requests.get(image_url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0'
        })
        img_response.raise_for_status()
        image_data = base64.standard_b64encode(img_response.content).decode("utf-8")

        # Detect media type from response headers
        content_type = img_response.headers.get('Content-Type', 'image/jpeg')
        if 'png' in content_type:
            media_type = 'image/png'
        elif 'webp' in content_type:
            media_type = 'image/webp'
        else:
            media_type = 'image/jpeg'

        client = anthropic.Anthropic()
        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
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
  "aestheticScores": {
    "streetwear": 0.0,
    "vintage": 0.0,
    "minimalist": 0.0,
    "y2k": 0.0,
    "alternative": 0.0
  }
}
aestheticTags should be 3 descriptive style words like oversized, monochrome, layered.
detectedItems should list the visible clothing pieces like white tee, baggy jeans, chunky sneakers.
aestheticScores should be float values 0.0 to 1.0 showing how much each aesthetic applies."""
                        }
                    ],
                }
            ],
        )

        raw = message.content[0].text.strip()
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
    Main entry point. Runs color extraction and Claude analysis.
    Always returns a dict. Never raises an exception.
    """
    print(f"[analyze_post] Starting analysis for: {image_url}")

    result = {
        "palette": [],
        "aesthetic": None,
        "aestheticTags": [],
        "detectedItems": [],
        "styleDescription": None,
        "aestheticScores": {},
        "analyzed": False,
    }

    try:
        print("[analyze_post] Extracting color palette...")
        palette = extract_color_palette(image_url)
        print(f"[analyze_post] Palette extracted: {palette}")
        result["palette"] = palette

        print("[analyze_post] Calling Claude API...")
        claude_result = analyze_outfit_with_claude(image_url)
        print(f"[analyze_post] Claude result: {claude_result}")

        if claude_result:
            result["aesthetic"] = claude_result.get("aesthetic")
            result["aestheticTags"] = claude_result.get("aestheticTags", [])
            result["detectedItems"] = claude_result.get("detectedItems", [])
            result["styleDescription"] = claude_result.get("styleDescription")
            result["aestheticScores"] = claude_result.get("aestheticScores", {})
            result["analyzed"] = True
            print("[analyze_post] Analysis complete and analyzed=True")
        else:
            print("[analyze_post] Claude returned empty result")

    except Exception as e:
        print(f"[analyze_post] FAILED: {e}")

    return result
