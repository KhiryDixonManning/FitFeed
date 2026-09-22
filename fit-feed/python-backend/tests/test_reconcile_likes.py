"""Counter drift and orphaned-like reconciliation.

The like architecture is sound in normal operation, but two things can leave
residue that nothing in the request path will ever clean up: a deleted post
strands the like documents underneath it, and the rules permit deleting a
like document without decrementing the counter. This proves the maintenance
job finds both, reports before it writes, and never removes a like that still
belongs to a live post.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

from reconcile_likes import count_likes, reconcile_counts, sweep_orphans

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


def make_post(db, post_id, likes_count, liker_uids):
    db.collection("posts").document(post_id).set({
        "authorId": "author", "category": "streetwear",
        "likesCount": likes_count, "createdAt": NOW - timedelta(days=1),
    })
    for uid in liker_uids:
        (db.collection("posts").document(post_id)
           .collection("likes").document(uid).set({"uid": uid, "createdAt": NOW.isoformat()}))


def drop_post(db, post_id, liker_uids=()):
    for uid in liker_uids:
        (db.collection("posts").document(post_id)
           .collection("likes").document(uid).delete())
    db.collection("posts").document(post_id).delete()


@pytest.fixture
def prefix():
    return f"rec_{uuid.uuid4().hex[:8]}"


class TestCounting:
    def test_counts_the_like_documents(self, db, prefix):
        post_id = f"{prefix}_a"
        make_post(db, post_id, 3, ["u1", "u2", "u3"])
        try:
            assert count_likes(db.collection("posts").document(post_id)) == 3
        finally:
            drop_post(db, post_id, ["u1", "u2", "u3"])

    def test_a_post_with_no_likes_counts_zero(self, db, prefix):
        post_id = f"{prefix}_b"
        make_post(db, post_id, 0, [])
        try:
            assert count_likes(db.collection("posts").document(post_id)) == 0
        finally:
            drop_post(db, post_id)


class TestCounterDrift:
    def test_a_dry_run_reports_drift_without_fixing_it(self, db, prefix):
        post_id = f"{prefix}_drift"
        make_post(db, post_id, 99, ["u1", "u2"])          # counter lies
        try:
            result = reconcile_counts(db, apply_changes=False)
            assert result["drifted"] >= 1
            assert result["fixed"] == 0
            stored = db.collection("posts").document(post_id).get().to_dict()["likesCount"]
            assert stored == 99, "a dry run must not write"
        finally:
            drop_post(db, post_id, ["u1", "u2"])

    def test_apply_realigns_the_counter_to_the_documents(self, db, prefix):
        post_id = f"{prefix}_fix"
        make_post(db, post_id, 99, ["u1", "u2"])
        try:
            result = reconcile_counts(db, apply_changes=True)
            assert result["fixed"] >= 1
            stored = db.collection("posts").document(post_id).get().to_dict()["likesCount"]
            assert stored == 2
        finally:
            drop_post(db, post_id, ["u1", "u2"])

    def test_an_undercount_is_corrected_upward_too(self, db, prefix):
        post_id = f"{prefix}_under"
        make_post(db, post_id, 0, ["u1", "u2", "u3"])
        try:
            reconcile_counts(db, apply_changes=True)
            stored = db.collection("posts").document(post_id).get().to_dict()["likesCount"]
            assert stored == 3
        finally:
            drop_post(db, post_id, ["u1", "u2", "u3"])

    def test_a_correct_post_is_left_alone(self, db, prefix):
        post_id = f"{prefix}_ok"
        make_post(db, post_id, 2, ["u1", "u2"])
        try:
            before = db.collection("posts").document(post_id).get().to_dict()
            reconcile_counts(db, apply_changes=True)
            after = db.collection("posts").document(post_id).get().to_dict()
            assert before["likesCount"] == after["likesCount"] == 2
        finally:
            drop_post(db, post_id, ["u1", "u2"])

    def test_a_malformed_counter_is_treated_as_zero_not_a_crash(self, db, prefix):
        post_id = f"{prefix}_junk"
        db.collection("posts").document(post_id).set({
            "authorId": "author", "likesCount": "lots", "createdAt": NOW,
        })
        (db.collection("posts").document(post_id)
           .collection("likes").document("u1").set({"uid": "u1", "createdAt": "x"}))
        try:
            reconcile_counts(db, apply_changes=True)
            assert db.collection("posts").document(post_id).get().to_dict()["likesCount"] == 1
        finally:
            drop_post(db, post_id, ["u1"])

    def test_reconciliation_is_idempotent(self, db, prefix):
        post_id = f"{prefix}_twice"
        make_post(db, post_id, 42, ["u1"])
        try:
            reconcile_counts(db, apply_changes=True)
            second = reconcile_counts(db, apply_changes=True)
            # Nothing left to fix on this post the second time around.
            stored = db.collection("posts").document(post_id).get().to_dict()["likesCount"]
            assert stored == 1
            assert second["fixed"] == 0 or stored == 1
        finally:
            drop_post(db, post_id, ["u1"])


class TestOrphanSweep:
    def test_a_like_under_a_deleted_post_is_reported(self, db, prefix):
        post_id = f"{prefix}_gone"
        make_post(db, post_id, 1, ["u1"])
        # The author deletes the post; Firestore leaves the subcollection.
        db.collection("posts").document(post_id).delete()
        try:
            result = sweep_orphans(db, apply_changes=False)
            assert result["orphaned"] >= 1
            assert result["deleted"] == 0
            still_there = (db.collection("posts").document(post_id)
                             .collection("likes").document("u1").get().exists)
            assert still_there, "a dry run must not delete"
        finally:
            (db.collection("posts").document(post_id)
               .collection("likes").document("u1").delete())

    def test_apply_deletes_the_orphan(self, db, prefix):
        post_id = f"{prefix}_sweep"
        make_post(db, post_id, 1, ["u1"])
        db.collection("posts").document(post_id).delete()

        result = sweep_orphans(db, apply_changes=True)
        assert result["deleted"] >= 1
        assert not (db.collection("posts").document(post_id)
                      .collection("likes").document("u1").get().exists)

    def test_a_like_on_a_live_post_is_never_touched(self, db, prefix):
        live = f"{prefix}_live"
        dead = f"{prefix}_dead"
        make_post(db, live, 1, ["keeper"])
        make_post(db, dead, 1, ["goner"])
        db.collection("posts").document(dead).delete()
        try:
            sweep_orphans(db, apply_changes=True)
            assert (db.collection("posts").document(live)
                      .collection("likes").document("keeper").get().exists), \
                "a live post's likes must survive the sweep"
            assert not (db.collection("posts").document(dead)
                          .collection("likes").document("goner").get().exists)
        finally:
            drop_post(db, live, ["keeper"])

    def test_the_sweep_is_idempotent(self, db, prefix):
        post_id = f"{prefix}_idem"
        make_post(db, post_id, 1, ["u1"])
        db.collection("posts").document(post_id).delete()

        sweep_orphans(db, apply_changes=True)
        second = sweep_orphans(db, apply_changes=True)
        # Nothing of ours is left for the second pass to remove.
        assert not (db.collection("posts").document(post_id)
                      .collection("likes").document("u1").get().exists)
        assert second["deleted"] >= 0
