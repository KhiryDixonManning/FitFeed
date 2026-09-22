"""Rate-limit behaviour on the costly endpoints."""

from __future__ import annotations

import pytest

import app as app_module
import auth as auth_module
import rate_limit
from rate_limit import SlidingWindowLimiter, reset_all_limiters


@pytest.fixture(autouse=True)
def clean_limiters():
    reset_all_limiters()
    yield
    reset_all_limiters()


@pytest.fixture
def client():
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as test_client:
        yield test_client


def as_user(monkeypatch, uid: str):
    monkeypatch.setattr(
        auth_module,
        "verify_request_token",
        lambda: {"uid": uid, "email": f"{uid}@example.com"},
    )
    return {"Authorization": "Bearer fake-but-accepted"}


class TestWindowMechanics:
    def test_allows_up_to_the_limit_then_blocks(self):
        limiter = SlidingWindowLimiter(limit=3, window_seconds=60, name="t")
        for _ in range(3):
            allowed, _ = limiter.check("k", now=100.0)
            assert allowed
        allowed, retry_after = limiter.check("k", now=100.0)
        assert not allowed
        assert retry_after > 0

    def test_the_window_slides(self):
        limiter = SlidingWindowLimiter(limit=2, window_seconds=60, name="t")
        assert limiter.check("k", now=0.0)[0]
        assert limiter.check("k", now=1.0)[0]
        assert not limiter.check("k", now=2.0)[0]
        # Once the first hits age out, capacity returns.
        assert limiter.check("k", now=61.5)[0]

    def test_keys_are_independent(self):
        limiter = SlidingWindowLimiter(limit=1, window_seconds=60, name="t")
        assert limiter.check("a", now=0.0)[0]
        assert not limiter.check("a", now=0.0)[0]
        assert limiter.check("b", now=0.0)[0]

    def test_idle_keys_are_evicted(self):
        limiter = SlidingWindowLimiter(limit=1, window_seconds=1, name="t")
        for i in range(rate_limit._MAX_TRACKED_KEYS + 50):
            limiter.check(f"key{i}", now=float(i))
        # Bookkeeping must not grow without bound on a long-lived worker.
        assert len(limiter._hits) <= rate_limit._MAX_TRACKED_KEYS + 1


class TestAnalyzeLimit:
    def test_requests_under_the_limit_are_served(self, client, monkeypatch):
        headers = as_user(monkeypatch, "alice")
        for _ in range(rate_limit.ANALYZE_BURST.limit):
            response = client.post("/analyze", json={"postId": "abc123"}, headers=headers)
            # Firestore is unavailable in tests, so a served request is 503 -
            # the point is that it was not rejected as rate limited.
            assert response.status_code != 429

    def test_exceeding_the_burst_limit_returns_429(self, client, monkeypatch):
        headers = as_user(monkeypatch, "alice")
        for _ in range(rate_limit.ANALYZE_BURST.limit):
            client.post("/analyze", json={"postId": "abc123"}, headers=headers)

        response = client.post("/analyze", json={"postId": "abc123"}, headers=headers)
        assert response.status_code == 429
        body = response.get_json()
        assert body["error"] == "rate_limited"
        assert "Retry-After" in response.headers

    def test_one_user_does_not_consume_another_users_quota(self, client, monkeypatch):
        alice = as_user(monkeypatch, "alice")
        for _ in range(rate_limit.ANALYZE_BURST.limit + 2):
            client.post("/analyze", json={"postId": "abc123"}, headers=alice)
        assert client.post("/analyze", json={"postId": "abc"}, headers=alice).status_code == 429

        bob = as_user(monkeypatch, "bob")
        assert client.post("/analyze", json={"postId": "abc"}, headers=bob).status_code != 429

    def test_unauthenticated_requests_are_rejected_before_any_work(self, client):
        # No token: 401 every time, and no quota is consumed or bypassed.
        for _ in range(rate_limit.ANALYZE_BURST.limit + 5):
            response = client.post("/analyze", json={"postId": "abc123"})
            assert response.status_code == 401

    def test_an_invalid_token_cannot_bypass_the_limiter(self, client):
        for _ in range(rate_limit.ANALYZE_BURST.limit + 5):
            response = client.post(
                "/analyze", json={"postId": "abc"}, headers={"Authorization": "Bearer bogus"}
            )
            assert response.status_code in (401, 503)

    def test_requests_never_reach_the_model(self, client, monkeypatch):
        """/analyze enqueues; it must not invoke the model on any path."""
        import outfit_analyzer

        calls: list[str] = []

        def spy(*args, **kwargs):
            calls.append("invoked")
            return {"analyzed": True}

        monkeypatch.setattr(outfit_analyzer, "analyze_image_bytes", spy)

        headers = as_user(monkeypatch, "alice")
        for _ in range(rate_limit.ANALYZE_BURST.limit + 5):
            client.post("/analyze", json={"postId": "abc123"}, headers=headers)

        # Not "not after the 429s" - never, on any request. The paid call
        # happens in the worker process, which no HTTP request can trigger.
        assert calls == []


class TestRankLimit:
    def test_rank_has_a_more_generous_allowance_than_analyze(self):
        assert rate_limit.RANK_BURST.limit > rate_limit.ANALYZE_BURST.limit
        assert rate_limit.RANK_SUSTAINED.limit > rate_limit.ANALYZE_SUSTAINED.limit

    def test_normal_feed_usage_is_not_limited(self, client, monkeypatch):
        headers = as_user(monkeypatch, "alice")
        for _ in range(20):
            response = client.post("/trending", json={"posts": []}, headers=headers)
            assert response.status_code == 200

    def test_the_feed_endpoint_eventually_limits(self, client, monkeypatch):
        headers = as_user(monkeypatch, "alice")
        for _ in range(rate_limit.RANK_BURST.limit):
            client.post("/feed", json={"mode": "discover"}, headers=headers)
        assert client.post("/feed", json={"mode": "discover"},
                           headers=headers).status_code == 429


class TestAdminLimit:
    def test_admin_route_is_damped_by_peer_address(self, client, monkeypatch):
        monkeypatch.setenv("ADMIN_API_KEY", "the-real-key")
        statuses = [
            client.post("/reanalyze-all", headers={"X-Admin-Key": "guess"}).status_code
            for _ in range(rate_limit.ADMIN_LIMITER.limit + 3)
        ]
        assert 403 in statuses           # wrong key rejected
        assert statuses[-1] == 429       # and guessing gets throttled
