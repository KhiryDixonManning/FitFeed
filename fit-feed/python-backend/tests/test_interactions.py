"""Interaction signals: validation, idempotence, scope and abuse resistance.

These are recommendation signals, so the tests care about two things in
equal measure: that a real signal is recorded faithfully, and that the
endpoint cannot be turned into a general-purpose tracker or a way to write
into somebody else's subtree.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

import app as app_module
import auth as auth_module
import rate_limit
from interactions import (
    DWELL_BUCKETS,
    INTERACTION_TYPES,
    MAX_NOT_INTERESTED_SCANNED,
    OPPOSING_TYPES,
    TYPE_IMPRESSION,
    TYPE_MORE_LIKE_THIS,
    TYPE_NOT_INTERESTED,
    TYPE_VIEW,
    fetch_interactions,
    fetch_not_interested_ids,
    interaction_doc_id,
    is_valid_post_id,
    normalize_dwell_bucket,
)
from validation import ValidationError, require_interaction

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------- pure helpers


class TestDocumentIdentity:
    def test_id_is_derived_from_type_and_post(self):
        assert interaction_doc_id(TYPE_IMPRESSION, "abc") == "impression_abc"

    def test_the_same_signal_always_lands_on_the_same_document(self):
        """This is what makes repeat impressions free and non-inflating."""
        ids = {interaction_doc_id(TYPE_IMPRESSION, "abc") for _ in range(50)}
        assert len(ids) == 1

    def test_different_types_on_one_post_do_not_collide(self):
        ids = {interaction_doc_id(t, "abc") for t in INTERACTION_TYPES}
        assert len(ids) == len(INTERACTION_TYPES)

    def test_explicit_feedback_is_mutually_exclusive(self):
        assert OPPOSING_TYPES[TYPE_MORE_LIKE_THIS] == TYPE_NOT_INTERESTED
        assert OPPOSING_TYPES[TYPE_NOT_INTERESTED] == TYPE_MORE_LIKE_THIS
        # Passive signals have no opposite - they are never contradictory.
        assert TYPE_IMPRESSION not in OPPOSING_TYPES
        assert TYPE_VIEW not in OPPOSING_TYPES


class TestPostIdSafety:
    @pytest.mark.parametrize("post_id", ["abc", "a-b_C9", "x" * 200])
    def test_accepts_ordinary_ids(self, post_id):
        assert is_valid_post_id(post_id)

    @pytest.mark.parametrize("post_id", [
        "", "x" * 201, "a/b", "../../etc", "a b", "a.b", None, 7, ["a"], {"a": 1},
    ])
    def test_rejects_anything_that_could_escape_the_document_path(self, post_id):
        assert not is_valid_post_id(post_id)


class TestDwellBuckets:
    def test_only_coarse_buckets_survive(self):
        for bucket in DWELL_BUCKETS:
            assert normalize_dwell_bucket(bucket.upper()) == bucket

    @pytest.mark.parametrize("value", [None, 1500, "1500", "forever", "", {"ms": 10}])
    def test_precise_durations_are_not_storable(self, value):
        assert normalize_dwell_bucket(value) is None

    def test_there_are_only_three_buckets(self):
        # A privacy property, not a style one: the stored value cannot
        # reconstruct how long somebody actually looked at something.
        assert len(DWELL_BUCKETS) == 3


class TestRequestValidation:
    def test_accepts_a_plain_signal(self):
        spec = require_interaction({"postId": "abc", "type": "impression"})
        assert (spec.post_id, spec.type, spec.value) == ("abc", "impression", None)

    def test_accepts_a_dwell_bucket_on_a_view(self):
        spec = require_interaction({"postId": "abc", "type": "view", "value": "Long"})
        assert spec.value == "long"

    def test_rejects_an_unknown_signal_type(self):
        with pytest.raises(ValidationError):
            require_interaction({"postId": "abc", "type": "purchase_intent"})

    def test_rejects_a_dwell_bucket_on_a_non_view(self):
        with pytest.raises(ValidationError):
            require_interaction({"postId": "abc", "type": "impression", "value": "long"})

    def test_rejects_a_free_numeric_duration(self):
        with pytest.raises(ValidationError):
            require_interaction({"postId": "abc", "type": "view", "durationMs": 91234})

    @pytest.mark.parametrize("field", ["uid", "userId", "weight", "createdAt", "schemaVersion"])
    def test_the_client_cannot_supply_server_owned_fields(self, field):
        with pytest.raises(ValidationError):
            require_interaction({"postId": "abc", "type": "impression", field: "x"})

    def test_rejects_a_traversing_post_id(self):
        with pytest.raises(ValidationError):
            require_interaction({"postId": "../../users/admin", "type": "impression"})


# ------------------------------------------------------------- emulator reads


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture
def seeded_user(db):
    uid = f"inter_{uuid.uuid4().hex[:8]}"
    ref = db.collection("users").document(uid).collection("interactions")

    batch = db.batch()
    written = []
    for i in range(3):
        doc_id = interaction_doc_id(TYPE_NOT_INTERESTED, f"hidden{i}")
        batch.set(ref.document(doc_id), {
            "postId": f"hidden{i}", "type": TYPE_NOT_INTERESTED,
            "createdAt": NOW.isoformat(), "schemaVersion": 1,
        })
        written.append(doc_id)
    for i in range(5):
        doc_id = interaction_doc_id(TYPE_IMPRESSION, f"seen{i}")
        batch.set(ref.document(doc_id), {
            "postId": f"seen{i}", "type": TYPE_IMPRESSION,
            "createdAt": NOW.isoformat(), "schemaVersion": 1,
        })
        written.append(doc_id)
    batch.commit()

    yield uid, ref

    cleanup = db.batch()
    for doc_id in written:
        cleanup.delete(ref.document(doc_id))
    cleanup.commit()


class TestFetching:
    def test_reads_back_every_signal(self, db, seeded_user):
        uid, _ = seeded_user
        assert len(fetch_interactions(db, uid)) == 8

    def test_hidden_posts_are_isolated_from_other_signals(self, db, seeded_user):
        uid, _ = seeded_user
        assert fetch_not_interested_ids(db, uid) == {"hidden0", "hidden1", "hidden2"}

    def test_a_user_with_no_history_reads_as_empty_not_broken(self, db):
        assert fetch_interactions(db, f"ghost_{uuid.uuid4().hex[:6]}") == []
        assert fetch_not_interested_ids(db, f"ghost_{uuid.uuid4().hex[:6]}") == set()

    def test_rewriting_the_same_impression_does_not_add_a_document(self, db, seeded_user):
        uid, ref = seeded_user
        for _ in range(10):
            ref.document(interaction_doc_id(TYPE_IMPRESSION, "seen0")).set({
                "postId": "seen0", "type": TYPE_IMPRESSION,
                "createdAt": NOW.isoformat(), "schemaVersion": 1,
            })
        assert len(fetch_interactions(db, uid)) == 8

    def test_a_malformed_hidden_entry_is_skipped_not_fatal(self, db, seeded_user):
        uid, ref = seeded_user
        ref.document("not_interested_broken").set(
            {"postId": {"nested": "junk"}, "type": TYPE_NOT_INTERESTED}
        )
        try:
            assert fetch_not_interested_ids(db, uid) == {"hidden0", "hidden1", "hidden2"}
        finally:
            ref.document("not_interested_broken").delete()

    def test_the_hidden_scan_is_bounded(self, db, seeded_user):
        uid, _ = seeded_user
        # The cap exists so that hiding thousands of posts cannot make every
        # feed request progressively more expensive.
        assert MAX_NOT_INTERESTED_SCANNED <= 200
        assert len(fetch_not_interested_ids(db, uid, limit=2)) == 2


# ------------------------------------------------------------- HTTP behaviour


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


def as_user(monkeypatch, uid, db=None):
    monkeypatch.setattr(
        auth_module, "verify_request_token",
        lambda: {"uid": uid, "email": f"{uid}@example.com"},
    )
    if db is not None:
        # The Admin SDK has no credentials in tests; point the route at the
        # same emulator client the helper-level tests use.
        monkeypatch.setattr(app_module, "get_db", lambda: db)
    return {"Authorization": "Bearer accepted-in-tests"}


@pytest.fixture
def a_post(db):
    post_id = f"ipost_{uuid.uuid4().hex[:8]}"
    db.collection("posts").document(post_id).set({
        "authorId": "someone", "category": "streetwear",
        "createdAt": NOW - timedelta(days=1),
    })
    yield post_id
    db.collection("posts").document(post_id).delete()


class TestEndpoint:
    def test_requires_authentication(self, client):
        response = client.post("/interactions", json={"postId": "abc", "type": "impression"})
        assert response.status_code == 401

    def test_records_a_signal_under_the_calling_user(self, client, db, monkeypatch, a_post):
        uid = f"caller_{uuid.uuid4().hex[:6]}"
        headers = as_user(monkeypatch, uid, db)
        response = client.post(
            "/interactions", json={"postId": a_post, "type": "more_like_this"}, headers=headers
        )
        assert response.status_code == 200

        ref = (db.collection("users").document(uid)
                 .collection("interactions").document(f"more_like_this_{a_post}"))
        stored = ref.get().to_dict()
        assert stored["postId"] == a_post
        assert stored["type"] == "more_like_this"
        # The server stamps time and version; the client supplies neither.
        assert "createdAt" in stored and stored["schemaVersion"] == 1
        ref.delete()

    def test_a_signal_written_for_someone_else_still_lands_on_the_caller(
        self, client, db, monkeypatch, a_post
    ):
        """A forged uid in the body must be ignored, not honoured."""
        uid = f"caller_{uuid.uuid4().hex[:6]}"
        headers = as_user(monkeypatch, uid, db)
        response = client.post(
            "/interactions",
            json={"postId": a_post, "type": "impression", "uid": "victim"},
            headers=headers,
        )
        # Rejected outright as an unaccepted field - nothing is written anywhere.
        assert response.status_code == 400
        victim = (db.collection("users").document("victim")
                    .collection("interactions").document(f"impression_{a_post}"))
        assert not victim.get().exists

    def test_opposing_feedback_replaces_rather_than_accumulates(
        self, client, db, monkeypatch, a_post
    ):
        uid = f"caller_{uuid.uuid4().hex[:6]}"
        headers = as_user(monkeypatch, uid, db)
        inter = db.collection("users").document(uid).collection("interactions")

        client.post("/interactions", json={"postId": a_post, "type": "not_interested"},
                    headers=headers)
        assert inter.document(f"not_interested_{a_post}").get().exists

        client.post("/interactions", json={"postId": a_post, "type": "more_like_this"},
                    headers=headers)
        assert inter.document(f"more_like_this_{a_post}").get().exists
        assert not inter.document(f"not_interested_{a_post}").get().exists

        inter.document(f"more_like_this_{a_post}").delete()

    def test_explicit_feedback_bumps_the_taste_generation(
        self, client, db, monkeypatch, a_post
    ):
        uid = f"caller_{uuid.uuid4().hex[:6]}"
        headers = as_user(monkeypatch, uid, db)
        client.post("/interactions", json={"postId": a_post, "type": "not_interested"},
                    headers=headers)
        state = db.collection("userTasteState").document(uid).get().to_dict()
        assert state["generation"] >= 1

        db.collection("userTasteState").document(uid).delete()
        (db.collection("users").document(uid)
           .collection("interactions").document(f"not_interested_{a_post}").delete())

    def test_a_signal_for_a_post_that_does_not_exist_is_refused(
        self, client, db, monkeypatch
    ):
        headers = as_user(monkeypatch, f"caller_{uuid.uuid4().hex[:6]}", db)
        response = client.post(
            "/interactions", json={"postId": "no_such_post_id", "type": "impression"},
            headers=headers,
        )
        assert response.status_code == 404

    def test_signal_spam_is_rate_limited(self, client, db, monkeypatch, a_post):
        headers = as_user(monkeypatch, f"caller_{uuid.uuid4().hex[:6]}", db)
        for _ in range(rate_limit.RANK_BURST.limit):
            client.post("/interactions", json={"postId": a_post, "type": "impression"},
                        headers=headers)
        response = client.post("/interactions", json={"postId": a_post, "type": "impression"},
                               headers=headers)
        assert response.status_code == 429
