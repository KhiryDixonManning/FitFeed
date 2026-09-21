"""The admin reanalysis sweep: dry run by default, queue-only, bounded.

Bulk reanalysis is real spend. These tests exist to make sure it can never
start as a side effect of calling the endpoint, never performs a model call
in the web process, and never re-arms an exhausted post without being told
to in the request.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

import app as app_module
import outfit_analyzer
import rate_limit
from analysis_jobs import MAX_ANALYSIS_ATTEMPTS
from job_queue import JOBS_COLLECTION

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
ADMIN = {"X-Admin-Key": "the-real-key"}


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture(autouse=True)
def clean_limiters():
    rate_limit.reset_all_limiters()
    yield
    rate_limit.reset_all_limiters()


@pytest.fixture
def client():
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as test_client:
        yield test_client


@pytest.fixture
def no_model_calls(monkeypatch):
    """Any model invocation at all is a failure in this module."""
    calls: list[str] = []

    def spy(*args, **kwargs):
        calls.append("invoked")
        return {"analyzed": True}

    monkeypatch.setattr(outfit_analyzer, "analyze_image_bytes", spy)
    return calls


@pytest.fixture
def admin(monkeypatch, db):
    monkeypatch.setenv("ADMIN_API_KEY", "the-real-key")
    monkeypatch.setattr(app_module, "get_db", lambda: db)
    return ADMIN


@pytest.fixture
def corpus(db):
    """Posts covering every branch the sweep has to decide between."""
    prefix = f"sweep_{uuid.uuid4().hex[:8]}"
    ids = {
        "needs": f"{prefix}_needs",
        "done": f"{prefix}_done",
        "no_image": f"{prefix}_no_image",
        "exhausted": f"{prefix}_exhausted",
        "old_palette": f"{prefix}_old_palette",
    }
    url = "https://fitfeed-67ee8.firebasestorage.app/o/x.jpg"

    batch = db.batch()
    batch.set(db.collection("posts").document(ids["needs"]), {
        "authorId": "alice", "imageUrl": url, "analyzed": False,
        "analysisAttempts": 1, "createdAt": NOW - timedelta(days=1),
    })
    batch.set(db.collection("posts").document(ids["done"]), {
        "authorId": "alice", "imageUrl": url, "analyzed": True,
        "outfitName": "Fit", "palette": [{"hex": "#000000", "percentage": 50}],
        "createdAt": NOW - timedelta(days=1),
    })
    batch.set(db.collection("posts").document(ids["no_image"]), {
        "authorId": "alice", "analyzed": False, "createdAt": NOW - timedelta(days=1),
    })
    batch.set(db.collection("posts").document(ids["exhausted"]), {
        "authorId": "alice", "imageUrl": url, "analyzed": False,
        "analysisAttempts": MAX_ANALYSIS_ATTEMPTS, "createdAt": NOW - timedelta(days=1),
    })
    batch.set(db.collection("posts").document(ids["old_palette"]), {
        "authorId": "alice", "imageUrl": url, "analyzed": True,
        "outfitName": "Fit", "palette": ["#ff0000"],  # legacy string palette
        "createdAt": NOW - timedelta(days=1),
    })
    batch.commit()

    yield ids

    cleanup = db.batch()
    for post_id in ids.values():
        cleanup.delete(db.collection("posts").document(post_id))
        cleanup.delete(db.collection(JOBS_COLLECTION).document(post_id))
    cleanup.commit()


def jobs_for(db, ids):
    existing = set()
    for name, post_id in ids.items():
        if db.collection(JOBS_COLLECTION).document(post_id).get().exists:
            existing.add(name)
    return existing


class TestDryRunIsTheDefault:
    def test_a_bare_call_enqueues_nothing(self, client, db, admin, corpus, no_model_calls):
        response = client.post("/reanalyze-all", headers=admin)
        assert response.status_code == 200

        body = response.get_json()
        assert body["status"] == "dry_run"
        assert body["applied"] is False
        assert jobs_for(db, corpus) == set()
        assert no_model_calls == []

    def test_the_dry_run_reports_what_it_would_do(self, client, db, admin, corpus, no_model_calls):
        body = client.post("/reanalyze-all", headers=admin).get_json()
        # Two posts need work (never analyzed, legacy palette); one is done,
        # one has no image, one has spent its budget.
        assert body["queued"] >= 2
        assert body["exhaustedSkipped"] >= 1
        assert body["skipped"] >= 2

    def test_apply_false_is_still_a_dry_run(self, client, db, admin, corpus, no_model_calls):
        body = client.post("/reanalyze-all", json={"apply": False}, headers=admin).get_json()
        assert body["applied"] is False
        assert jobs_for(db, corpus) == set()

    def test_a_truthy_string_does_not_count_as_apply(self, client, db, admin, corpus):
        # "apply": "yes" is not an approval; only the boolean is.
        body = client.post("/reanalyze-all", json={"apply": "yes"}, headers=admin).get_json()
        assert body["applied"] is False
        assert jobs_for(db, corpus) == set()


class TestApplying:
    def test_queues_the_posts_that_need_work(self, client, db, admin, corpus, no_model_calls):
        body = client.post("/reanalyze-all", json={"apply": True}, headers=admin).get_json()
        assert body["status"] == "queued"

        queued = jobs_for(db, corpus)
        assert "needs" in queued
        assert "old_palette" in queued
        assert "done" not in queued
        assert "no_image" not in queued
        # Still no paid call from the web process - the worker does that.
        assert no_model_calls == []

    def test_an_exhausted_post_is_left_alone(self, client, db, admin, corpus, no_model_calls):
        client.post("/reanalyze-all", json={"apply": True}, headers=admin)
        assert "exhausted" not in jobs_for(db, corpus)
        assert (db.collection("posts").document(corpus["exhausted"]).get()
                  .to_dict()["analysisAttempts"]) == MAX_ANALYSIS_ATTEMPTS

    def test_resetting_attempts_is_explicit_and_re_arms_the_post(
        self, client, db, admin, corpus, no_model_calls
    ):
        client.post("/reanalyze-all", json={"apply": True, "resetAttempts": True}, headers=admin)
        assert "exhausted" in jobs_for(db, corpus)
        assert (db.collection("posts").document(corpus["exhausted"]).get()
                  .to_dict()["analysisAttempts"]) == 0

    def test_resetting_without_applying_changes_nothing(self, client, db, admin, corpus):
        body = client.post(
            "/reanalyze-all", json={"resetAttempts": True}, headers=admin
        ).get_json()
        assert body["applied"] is False
        assert jobs_for(db, corpus) == set()
        assert (db.collection("posts").document(corpus["exhausted"]).get()
                  .to_dict()["analysisAttempts"]) == MAX_ANALYSIS_ATTEMPTS

    def test_running_twice_does_not_double_the_work(self, client, db, admin, corpus):
        client.post("/reanalyze-all", json={"apply": True}, headers=admin)
        first = db.collection(JOBS_COLLECTION).document(corpus["needs"]).get().to_dict()

        rate_limit.reset_all_limiters()
        client.post("/reanalyze-all", json={"apply": True}, headers=admin)
        second = db.collection(JOBS_COLLECTION).document(corpus["needs"]).get().to_dict()

        # Same document, same attempt budget: re-enqueuing is idempotent.
        assert second["postId"] == first["postId"]
        assert second["attempts"] == first["attempts"]


class TestBounds:
    def test_the_scan_is_capped(self, client, admin, corpus):
        body = client.post("/reanalyze-all", json={"limit": 2}, headers=admin).get_json()
        assert body["scanned"] <= 2
        assert body["scanLimit"] == 2

    @pytest.mark.parametrize("limit", [0, -1, 100000, "all", 1.5, True, None])
    def test_a_nonsense_limit_is_refused(self, client, admin, limit):
        response = client.post("/reanalyze-all", json={"limit": limit}, headers=admin)
        assert response.status_code == 400

    def test_a_non_object_body_is_refused(self, client, admin):
        response = client.post("/reanalyze-all", json=["apply"], headers=admin)
        assert response.status_code == 400

    def test_no_body_at_all_is_fine(self, client, admin, corpus):
        assert client.post("/reanalyze-all", headers=admin).status_code == 200


class TestStillGated:
    def test_a_wrong_key_cannot_apply(self, client, db, monkeypatch, corpus):
        monkeypatch.setenv("ADMIN_API_KEY", "the-real-key")
        monkeypatch.setattr(app_module, "get_db", lambda: db)
        response = client.post(
            "/reanalyze-all", json={"apply": True}, headers={"X-Admin-Key": "guess"}
        )
        assert response.status_code == 403
        assert jobs_for(db, corpus) == set()

    def test_no_key_configured_means_the_route_does_not_exist(
        self, client, db, monkeypatch, corpus
    ):
        monkeypatch.delenv("ADMIN_API_KEY", raising=False)
        monkeypatch.setattr(app_module, "get_db", lambda: db)
        response = client.post("/reanalyze-all", json={"apply": True})
        assert response.status_code == 404
        assert jobs_for(db, corpus) == set()
