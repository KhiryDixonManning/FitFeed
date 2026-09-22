# image_fetch.py
"""Safe retrieval of post images.

The analyser used to be handed an arbitrary `imageUrl` by the browser and
called `requests.get()` on it, which is a server-side request forgery primitive:
a caller could point it at cloud metadata endpoints, internal services, or
localhost. Image URLs now come from trusted Firestore documents and are still
validated here (defence in depth) before anything is fetched.

Protections:
  * https only, and only Firebase/Google Storage hosts for this project
  * redirects are not followed (a trusted host must not be able to bounce us)
  * connect/read timeouts
  * a hard byte ceiling enforced while streaming, not after
  * the payload must decode as an image, whatever the Content-Type claimed
  * pixel-count ceiling, so a decompression bomb cannot exhaust memory
"""

from __future__ import annotations

import logging
import os
from io import BytesIO
from urllib.parse import urlparse

import requests
from PIL import Image

log = logging.getLogger(__name__)

STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET", "fitfeed-67ee8.firebasestorage.app")

ALLOWED_HOSTS = {
    "firebasestorage.googleapis.com",
    "storage.googleapis.com",
    f"{STORAGE_BUCKET}.storage.googleapis.com",
}

MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024      # matches the Storage upload ceiling
MAX_PIXELS = 40_000_000                    # ~40 MP decoded
CONNECT_TIMEOUT_S = 5
READ_TIMEOUT_S = 15

# Pillow refuses images beyond this many pixels outright.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ImageFetchError(Exception):
    """Raised when a URL is untrusted or the payload is not a usable image."""


def validate_image_url(url: str) -> str:
    """Reject anything that is not an image in this project's Storage bucket."""
    if not isinstance(url, str) or not url:
        raise ImageFetchError("Missing image URL.")
    if len(url) > 2000:
        raise ImageFetchError("Image URL is too long.")

    parsed = urlparse(url)

    if parsed.scheme != "https":
        raise ImageFetchError("Image URL must use https.")
    if parsed.hostname not in ALLOWED_HOSTS:
        raise ImageFetchError("Image URL host is not an allowed storage host.")
    if parsed.port not in (None, 443):
        raise ImageFetchError("Image URL must use the default https port.")

    # firebasestorage.googleapis.com serves every project; pin ours.
    if parsed.hostname == "firebasestorage.googleapis.com":
        if not parsed.path.startswith(f"/v0/b/{STORAGE_BUCKET}/o/"):
            raise ImageFetchError("Image URL does not belong to this project's bucket.")
    elif parsed.hostname == "storage.googleapis.com":
        if not parsed.path.startswith(f"/{STORAGE_BUCKET}/"):
            raise ImageFetchError("Image URL does not belong to this project's bucket.")

    return url


def _read_capped(response: requests.Response, limit: int) -> bytes:
    """Stream the body, aborting as soon as it exceeds `limit`."""
    buffer = bytearray()
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        buffer.extend(chunk)
        if len(buffer) > limit:
            raise ImageFetchError("Image exceeds the maximum allowed size.")
    return bytes(buffer)


def verify_image_bytes(data: bytes) -> tuple[str, tuple[int, int]]:
    """Confirm the bytes really are a decodable image of sane dimensions.

    Returns (format, (width, height)). Content-Type headers are attacker-
    influenced, so the actual bytes are what we trust.
    """
    if not data:
        raise ImageFetchError("Downloaded image was empty.")

    try:
        with Image.open(BytesIO(data)) as probe:
            probe.verify()  # structural check; consumes the file object
    except ImageFetchError:
        raise
    except Exception as exc:
        raise ImageFetchError("Downloaded file is not a readable image.") from exc

    # verify() leaves the image unusable, so reopen for the metadata.
    try:
        with Image.open(BytesIO(data)) as img:
            fmt = (img.format or "").upper()
            width, height = img.size
    except Exception as exc:
        raise ImageFetchError("Downloaded file is not a readable image.") from exc

    if fmt not in {"JPEG", "PNG", "WEBP", "GIF", "HEIF", "HEIC"}:
        raise ImageFetchError(f"Unsupported image format: {fmt or 'unknown'}")
    if width <= 0 or height <= 0:
        raise ImageFetchError("Image has invalid dimensions.")
    if width * height > MAX_PIXELS:
        raise ImageFetchError("Image resolution is too large to process.")

    return fmt, (width, height)


def fetch_image_bytes(url: str) -> bytes:
    """Validate, download and verify an image. Raises ImageFetchError."""
    safe_url = validate_image_url(url)

    try:
        response = requests.get(
            safe_url,
            stream=True,
            allow_redirects=False,  # a redirect could leave the allowlist
            timeout=(CONNECT_TIMEOUT_S, READ_TIMEOUT_S),
            headers={"Accept": "image/*"},
        )
    except requests.RequestException as exc:
        raise ImageFetchError("Could not retrieve the image.") from exc

    with response:
        if response.is_redirect or response.is_permanent_redirect:
            raise ImageFetchError("Image URL redirected; refusing to follow.")
        if response.status_code != 200:
            raise ImageFetchError(f"Image request failed with status {response.status_code}.")

        declared_length = response.headers.get("Content-Length")
        if declared_length and declared_length.isdigit() and int(declared_length) > MAX_DOWNLOAD_BYTES:
            raise ImageFetchError("Image exceeds the maximum allowed size.")

        data = _read_capped(response, MAX_DOWNLOAD_BYTES)

    fmt, (width, height) = verify_image_bytes(data)
    log.info("Fetched image: format=%s dimensions=%dx%d bytes=%d", fmt, width, height, len(data))
    return data
