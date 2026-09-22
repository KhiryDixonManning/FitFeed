from io import BytesIO

import pytest
from PIL import Image

import image_fetch
from image_fetch import (
    ImageFetchError,
    STORAGE_BUCKET,
    _read_capped,
    validate_image_url,
    verify_image_bytes,
)

GOOD_URL = (
    f"https://firebasestorage.googleapis.com/v0/b/{STORAGE_BUCKET}"
    "/o/posts%2Fuid%2F1.jpg?alt=media&token=abc"
)


def make_image_bytes(fmt="JPEG", size=(64, 64), color=(120, 90, 60)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


class TestUrlAllowlist:
    def test_accepts_this_projects_storage_url(self):
        assert validate_image_url(GOOD_URL) == GOOD_URL

    def test_rejects_plain_http(self):
        with pytest.raises(ImageFetchError):
            validate_image_url(GOOD_URL.replace("https://", "http://"))

    def test_rejects_arbitrary_hosts(self):
        for url in (
            "https://evil.example.com/payload.jpg",
            "https://firebasestorage.googleapis.com.evil.example/x.jpg",
            "https://attacker.test/v0/b/bucket/o/x.jpg",
        ):
            with pytest.raises(ImageFetchError):
                validate_image_url(url)

    def test_rejects_ssrf_targets(self):
        # The classic SSRF destinations: metadata service, loopback, LAN.
        for url in (
            "http://169.254.169.254/latest/meta-data/",
            "https://169.254.169.254/latest/meta-data/",
            "http://localhost:5000/health",
            "https://127.0.0.1/admin",
            "https://192.168.1.10/internal",
            "http://metadata.google.internal/computeMetadata/v1/",
        ):
            with pytest.raises(ImageFetchError):
                validate_image_url(url)

    def test_rejects_non_http_schemes(self):
        for url in ("file:///etc/passwd", "gopher://127.0.0.1:11211/", "ftp://example.com/x.jpg"):
            with pytest.raises(ImageFetchError):
                validate_image_url(url)

    def test_rejects_another_firebase_project_bucket(self):
        with pytest.raises(ImageFetchError):
            validate_image_url(
                "https://firebasestorage.googleapis.com/v0/b/someone-elses-bucket/o/x.jpg"
            )

    def test_rejects_nonstandard_port(self):
        with pytest.raises(ImageFetchError):
            validate_image_url(
                f"https://firebasestorage.googleapis.com:8080/v0/b/{STORAGE_BUCKET}/o/x.jpg"
            )

    def test_rejects_empty_and_oversized(self):
        with pytest.raises(ImageFetchError):
            validate_image_url("")
        with pytest.raises(ImageFetchError):
            validate_image_url(None)
        with pytest.raises(ImageFetchError):
            validate_image_url("https://firebasestorage.googleapis.com/" + "x" * 2100)


class TestContentVerification:
    def test_accepts_a_real_jpeg(self):
        fmt, (width, height) = verify_image_bytes(make_image_bytes("JPEG"))
        assert fmt == "JPEG"
        assert (width, height) == (64, 64)

    def test_accepts_a_real_png(self):
        fmt, _ = verify_image_bytes(make_image_bytes("PNG"))
        assert fmt == "PNG"

    def test_rejects_non_image_payloads(self):
        # A Content-Type header claiming image/jpeg proves nothing.
        for payload in (b"<html><body>hi</body></html>", b"%PDF-1.4 fake", b"\x00\x01\x02\x03"):
            with pytest.raises(ImageFetchError):
                verify_image_bytes(payload)

    def test_rejects_empty_payload(self):
        with pytest.raises(ImageFetchError):
            verify_image_bytes(b"")

    def test_rejects_oversized_dimensions(self, monkeypatch):
        # Simulate a decompression bomb without allocating one.
        monkeypatch.setattr(image_fetch, "MAX_PIXELS", 100)
        with pytest.raises(ImageFetchError):
            verify_image_bytes(make_image_bytes("PNG", size=(64, 64)))


class FakeResponse:
    """Minimal stand-in for a streaming requests.Response."""

    def __init__(self, chunks):
        self._chunks = chunks

    def iter_content(self, chunk_size=None):
        return iter(self._chunks)


class TestSizeCap:
    def test_reads_small_bodies(self):
        data = _read_capped(FakeResponse([b"abc", b"def"]), limit=1024)
        assert data == b"abcdef"

    def test_aborts_once_the_limit_is_passed(self):
        # A server lying about Content-Length still cannot stream us to death.
        with pytest.raises(ImageFetchError):
            _read_capped(FakeResponse([b"x" * 600] * 10), limit=1024)

    def test_ignores_empty_chunks(self):
        assert _read_capped(FakeResponse([b"", b"ab", b"", b"cd"]), limit=10) == b"abcd"
