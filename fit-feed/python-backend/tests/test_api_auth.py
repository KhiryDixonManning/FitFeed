import pytest

import app as app_module
import auth as auth_module


@pytest.fixture
def client():
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as test_client:
        yield test_client


@pytest.fixture
def signed_in(monkeypatch):
    """Pretend the Authorization header carried a valid token for alice."""
    monkeypatch.setattr(
        auth_module,
        "verify_request_token",
        lambda: {"uid": "alice_uid", "email": "alice@example.com"},
    )
    return {"Authorization": "Bearer fake-but-accepted"}


AUTH = {"Authorization": "Bearer something"}


class TestPublicEndpoints:
    def test_health_needs_no_auth(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.get_json()["status"] == "ok"

    def test_root_needs_no_auth(self, client):
        assert client.get("/").status_code == 200


class TestAuthenticationRequired:
    @pytest.mark.parametrize("path", ["/feed", "/trending", "/analyze", "/interactions"])
    def test_missing_token_is_401(self, client, path):
        response = client.post(path, json={})
        assert response.status_code == 401
        assert response.get_json()["error"] == "missing_token"

    @pytest.mark.parametrize("path", ["/feed", "/trending", "/analyze", "/interactions"])
    def test_malformed_authorization_header_is_401(self, client, path):
        for header in ("Basic abc123", "Bearer", "Bearer    ", "token abc"):
            response = client.post(path, json={}, headers={"Authorization": header})
            assert response.status_code == 401, header

    def test_invalid_token_does_not_reach_the_handler(self, client, monkeypatch):
        # No credentials configured in tests, so verification is unavailable
        # rather than merely failing - either way the request is refused.
        response = client.post("/trending", json={"posts": []}, headers=AUTH)
        assert response.status_code in (401, 503)
        assert response.get_json()["error"] in ("invalid_token", "auth_unavailable")


class TestTrendingValidation:
    """/rank was removed with the client-side ranking path; /trending keeps
    the same client-supplied-posts contract and the same validation."""

    def test_rejects_a_non_json_body(self, client, signed_in):
        response = client.post("/trending", data="not json", headers=signed_in)
        assert response.status_code == 400
        assert response.get_json()["error"] == "invalid_request"

    def test_rejects_a_non_list_posts_field(self, client, signed_in):
        response = client.post("/trending", json={"posts": "everything"}, headers=signed_in)
        assert response.status_code == 400

    def test_rejects_too_many_posts(self, client, signed_in):
        payload = {"posts": [{"id": str(i)} for i in range(500)]}
        response = client.post("/trending", json=payload, headers=signed_in)
        assert response.status_code == 413

    def test_orders_a_valid_request(self, client, signed_in):
        payload = {
            "posts": [
                {"id": "a", "category": "streetwear", "likesCount": 10,
                 "commentsCount": 5, "createdAt": "2026-01-01T00:00:00Z"},
                {"id": "b", "category": "vintage", "likesCount": 1,
                 "commentsCount": 0, "createdAt": "2026-01-01T00:00:00Z"},
            ]
        }
        response = client.post("/trending", json=payload, headers=signed_in)
        assert response.status_code == 200
        assert {p["id"] for p in response.get_json()} == {"a", "b"}

    def test_empty_post_list_is_fine(self, client, signed_in):
        response = client.post("/trending", json={"posts": []}, headers=signed_in)
        assert response.status_code == 200
        assert response.get_json() == []

    def test_the_removed_rank_route_is_gone(self, client, signed_in):
        # Dead code removal is asserted, not assumed.
        assert client.post("/rank", json={"posts": []}, headers=signed_in).status_code == 404


class TestAnalyzeValidation:
    def test_requires_a_post_id(self, client, signed_in):
        response = client.post("/analyze", json={}, headers=signed_in)
        assert response.status_code == 400

    def test_rejects_a_traversal_style_post_id(self, client, signed_in):
        response = client.post("/analyze", json={"postId": "../../secrets"}, headers=signed_in)
        assert response.status_code == 400

    def test_no_longer_accepts_a_caller_supplied_image_url(self, client, signed_in):
        # The old SSRF-prone contract took an arbitrary imageUrl. Sending one
        # now fails validation because postId is what the endpoint requires.
        response = client.post(
            "/analyze",
            json={"imageUrl": "http://169.254.169.254/latest/meta-data/"},
            headers=signed_in,
        )
        assert response.status_code == 400

    def test_reports_unavailable_without_datastore_credentials(self, client, signed_in):
        # Firestore is unreachable in tests, so a well-formed request should
        # degrade to 503 rather than crashing or leaking a stack trace.
        response = client.post("/analyze", json={"postId": "abc123"}, headers=signed_in)
        assert response.status_code == 503
        assert response.get_json()["error"] == "unavailable"


class TestAdminEndpoint:
    def test_hidden_when_no_admin_key_configured(self, client, monkeypatch):
        monkeypatch.delenv("ADMIN_API_KEY", raising=False)
        response = client.post("/reanalyze-all")
        assert response.status_code == 404

    def test_rejects_a_wrong_key(self, client, monkeypatch):
        monkeypatch.setenv("ADMIN_API_KEY", "the-real-key")
        response = client.post("/reanalyze-all", headers={"X-Admin-Key": "guessed"})
        assert response.status_code == 403

    def test_rejects_a_missing_key_header(self, client, monkeypatch):
        monkeypatch.setenv("ADMIN_API_KEY", "the-real-key")
        assert client.post("/reanalyze-all").status_code == 403

    def test_accepts_the_correct_key(self, client, monkeypatch):
        monkeypatch.setenv("ADMIN_API_KEY", "the-real-key")
        response = client.post("/reanalyze-all", headers={"X-Admin-Key": "the-real-key"})
        # Past the gate; Firestore is unavailable in tests.
        assert response.status_code == 503

    def test_a_user_token_alone_does_not_grant_admin(self, client, monkeypatch, signed_in):
        monkeypatch.setenv("ADMIN_API_KEY", "the-real-key")
        response = client.post("/reanalyze-all", headers=signed_in)
        assert response.status_code == 403


class TestErrorSanitisation:
    def test_unknown_routes_return_json_not_html(self, client):
        response = client.get("/does-not-exist")
        assert response.status_code == 404
        assert response.get_json()["error"] == "not_found"

    def test_internal_errors_do_not_leak_details(self, client, signed_in, monkeypatch):
        def explode(*args, **kwargs):
            raise RuntimeError("secret internal detail: /srv/creds.json")

        monkeypatch.setattr(app_module, "get_trending", explode)
        response = client.post("/trending", json={"posts": []}, headers=signed_in)
        assert response.status_code == 500
        body = response.get_json()
        assert body["message"] == "Something went wrong."
        assert "secret internal detail" not in response.get_data(as_text=True)


class TestNoPaidCallsInTests:
    """Guard: the suite must never spend money on the Anthropic API."""

    def test_the_api_key_is_absent_from_the_test_environment(self):
        import os
        assert not os.environ.get("ANTHROPIC_API_KEY"), (
            "ANTHROPIC_API_KEY is set during tests; conftest should remove it "
            "so no test can make a paid call."
        )

    def test_the_analyser_short_circuits_without_a_key(self, monkeypatch):
        import outfit_analyzer

        def explode(*args, **kwargs):
            raise AssertionError("A test attempted a real Anthropic API call")

        monkeypatch.setattr(outfit_analyzer.anthropic, "Anthropic", explode)
        # No key configured, so the client is never constructed.
        assert outfit_analyzer.analyze_outfit_with_claude_bytes(b"not-an-image") == {}

    def test_image_analysis_falls_back_without_a_key(self, monkeypatch):
        import outfit_analyzer

        monkeypatch.setattr(
            outfit_analyzer, "extract_color_palette_from_bytes", lambda *a, **k: ["#123456"]
        )
        result = outfit_analyzer.analyze_image_bytes(b"bytes")
        assert result["analyzed"] is False
        assert result["palette"] == ["#123456"]
