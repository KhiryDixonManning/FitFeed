"""The like migration, across the full rollout lifecycle.

The migration runs at least twice: once before the new client ships, and once
at the end of the compatibility window. On that second run a uid sitting in
likedBy with no like document is ambiguous - either a legitimate tail-window
legacy like that needs backfilling, or a like the user deliberately removed
on the new client (which deletes the document but cannot touch the array).

Getting that wrong in either direction is a data bug a user would notice:
resurrect a like they removed, or silently drop one they made. The watermark
exists to tell them apart, and most of this file is about proving it does.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

from migrate_likes import WATERMARK_FIELD, classify, migrate, verify

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


# ------------------------------------------------- the decision table, pure


class TestClassify:
    """The seven states a (uid, post) pair can be in. No Firestore needed."""

    def test_first_run_migrates_every_legacy_liker(self):
        plan = classify({"likedBy": ["a", "b"]}, set())
        assert plan["first_run"] is True
        assert plan["to_create"] == ["a", "b"]
        assert plan["intentionally_removed"] == []

    def test_first_run_skips_likers_that_already_have_documents(self):
        plan = classify({"likedBy": ["a", "b"]}, {"a"})
        assert plan["to_create"] == ["b"]

    def test_rerun_creates_a_tail_window_like(self):
        # 'b' joined likedBy after the first migration: a real legacy like.
        plan = classify({"likedBy": ["a", "b"], WATERMARK_FIELD: ["a"]}, {"a"})
        assert plan["to_create"] == ["b"]
        assert plan["intentionally_removed"] == []

    def test_rerun_does_not_resurrect_an_intentionally_removed_like(self):
        # 'a' was migrated, then unliked on the new client: document gone,
        # array entry stranded. It must stay gone.
        plan = classify({"likedBy": ["a"], WATERMARK_FIELD: ["a"]}, set())
        assert plan["to_create"] == []
        assert plan["intentionally_removed"] == ["a"]

    def test_both_cases_are_correct_simultaneously(self):
        # THE case this design exists for: one user made a tail-window like,
        # another removed a migrated one, on the same post, at the same time.
        plan = classify(
            {"likedBy": ["removed", "tail"], WATERMARK_FIELD: ["removed"]},
            set(),
        )
        assert plan["to_create"] == ["tail"], "the tail-window like must be created"
        assert plan["intentionally_removed"] == ["removed"], "the removal must be preserved"

    def test_an_old_client_unlike_leaves_a_stale_document(self):
        # Removed from the array by an old client, which cannot delete the doc.
        plan = classify({"likedBy": [], WATERMARK_FIELD: ["a"]}, {"a"})
        assert plan["stale_documents"] == ["a"]
        assert plan["to_create"] == []

    def test_a_new_client_like_needs_nothing(self):
        plan = classify({"likedBy": [], WATERMARK_FIELD: []}, {"newbie"})
        assert plan["to_create"] == []
        assert plan["stale_documents"] == []

    def test_a_consistent_post_needs_nothing(self):
        plan = classify({"likedBy": ["a"], WATERMARK_FIELD: ["a"]}, {"a"})
        assert plan["to_create"] == []
        assert plan["intentionally_removed"] == []
        assert plan["stale_documents"] == []

    def test_the_watermark_grows_to_cover_new_legacy_likers(self):
        plan = classify({"likedBy": ["a", "b"], WATERMARK_FIELD: ["a"]}, {"a"})
        assert plan["next_watermark"] == ["a", "b"]

    def test_the_watermark_never_forgets(self):
        # 'a' left likedBy via an old client; the watermark still remembers we
        # migrated them, or a later run would treat them as brand new.
        plan = classify({"likedBy": [], WATERMARK_FIELD: ["a"]}, set())
        assert plan["next_watermark"] == ["a"]

    @pytest.mark.parametrize("junk", [None, "nope", 5, {"a": 1}, [1, 2], [""], [None]])
    def test_malformed_arrays_are_survivable(self, junk):
        plan = classify({"likedBy": junk, WATERMARK_FIELD: junk}, set())
        assert plan["to_create"] == []

    def test_duplicate_array_entries_collapse(self):
        plan = classify({"likedBy": ["a", "a", "a"]}, set())
        assert plan["to_create"] == ["a"]


# ------------------------------------------------------- against the emulator


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture(autouse=True)
def isolated(db, monkeypatch):
    """Each test sees only its own posts."""
    import migrate_likes
    monkeypatch.setattr(migrate_likes, "get_db", lambda: db)
    created: list[str] = []

    def cleanup():
        for post_id in created:
            ref = db.collection("posts").document(post_id)
            for like in ref.collection("likes").stream():
                like.reference.delete()
            ref.delete()

    cleanup()
    for post in db.collection("posts").stream():
        for like in post.reference.collection("likes").stream():
            like.reference.delete()
        post.reference.delete()
    yield created
    cleanup()


def make_post(db, post_id, *, liked_by, like_docs=(), likes_count=None, watermark=None):
    payload = {
        "authorId": "author", "category": "streetwear",
        "likedBy": list(liked_by),
        "likesCount": len(like_docs) if likes_count is None else likes_count,
        "createdAt": NOW - timedelta(days=1),
    }
    if watermark is not None:
        payload[WATERMARK_FIELD] = list(watermark)
    db.collection("posts").document(post_id).set(payload)
    for uid in like_docs:
        (db.collection("posts").document(post_id)
           .collection("likes").document(uid).set({"uid": uid, "createdAt": NOW}))
    return post_id


def state(db, post_id):
    ref = db.collection("posts").document(post_id)
    data = ref.get().to_dict() or {}
    return {
        "likesCount": data.get("likesCount"),
        "likedBy": sorted(data.get("likedBy") or []),
        "watermark": sorted(data.get(WATERMARK_FIELD) or []),
        "likeDocs": sorted(d.id for d in ref.collection("likes").stream()),
    }


class TestFirstMigration:
    def test_a_dry_run_writes_nothing(self, db, isolated):
        post_id = make_post(db, "m_dry", liked_by=["a", "b"], likes_count=2)
        isolated.append(post_id)

        assert migrate(apply_changes=False) == 0
        s = state(db, post_id)
        assert s["likeDocs"] == []
        assert s["watermark"] == []

    def test_apply_backfills_and_records_the_watermark(self, db, isolated):
        post_id = make_post(db, "m_apply", liked_by=["a", "b"], likes_count=2)
        isolated.append(post_id)

        assert migrate(apply_changes=True) == 0
        s = state(db, post_id)
        assert s["likeDocs"] == ["a", "b"]
        assert s["likesCount"] == 2
        assert s["watermark"] == ["a", "b"]
        assert s["likedBy"] == ["a", "b"], "likedBy must never be modified"

    def test_running_twice_changes_nothing(self, db, isolated):
        post_id = make_post(db, "m_idem", liked_by=["a"], likes_count=1)
        isolated.append(post_id)

        migrate(apply_changes=True)
        first = state(db, post_id)
        migrate(apply_changes=True)
        assert state(db, post_id) == first

    def test_the_count_follows_the_documents_not_the_array(self, db, isolated):
        post_id = make_post(db, "m_count", liked_by=["a", "b"], likes_count=99)
        isolated.append(post_id)

        migrate(apply_changes=True)
        assert state(db, post_id)["likesCount"] == 2


class TestTheResurrectionBug:
    """The regression this design exists to prevent."""

    def test_a_like_removed_after_migration_is_not_recreated(self, db, isolated):
        # Migrated, then the user unliked on the new client.
        post_id = make_post(
            db, "m_removed",
            liked_by=["ghost"], like_docs=(), likes_count=0, watermark=["ghost"],
        )
        isolated.append(post_id)

        migrate(apply_changes=True)

        s = state(db, post_id)
        assert s["likeDocs"] == [], "the removed like must NOT come back"
        assert s["likesCount"] == 0, "the counter must NOT be re-incremented"
        assert s["likedBy"] == ["ghost"], "the legacy array is still preserved"

    def test_repeated_reruns_never_resurrect_it(self, db, isolated):
        post_id = make_post(
            db, "m_removed_x3",
            liked_by=["ghost"], like_docs=(), likes_count=0, watermark=["ghost"],
        )
        isolated.append(post_id)

        for _ in range(3):
            migrate(apply_changes=True)
            s = state(db, post_id)
            assert s["likeDocs"] == []
            assert s["likesCount"] == 0

    def test_verify_stays_clean_after_an_intentional_removal(self, db, isolated):
        # Before the watermark, --verify flagged this as UNMIGRATED forever,
        # which would have blocked the strict-rules cutover permanently.
        post_id = make_post(
            db, "m_verify_removed",
            liked_by=["ghost"], like_docs=(), likes_count=0, watermark=["ghost"],
        )
        isolated.append(post_id)

        assert verify() == 0


class TestTailWindowLikes:
    def test_a_legacy_like_made_during_the_window_is_backfilled(self, db, isolated):
        # 'tail' was added to likedBy by an old client after the first run.
        post_id = make_post(
            db, "m_tail",
            liked_by=["early", "tail"], like_docs=["early"],
            likes_count=2, watermark=["early"],
        )
        isolated.append(post_id)

        migrate(apply_changes=True)

        s = state(db, post_id)
        assert s["likeDocs"] == ["early", "tail"]
        assert s["likesCount"] == 2
        assert s["watermark"] == ["early", "tail"]

    def test_a_tail_like_and_an_intentional_removal_on_the_same_post(self, db, isolated):
        # Both cases at once - the scenario the whole design turns on.
        post_id = make_post(
            db, "m_both",
            liked_by=["removed", "tail"], like_docs=[], likes_count=0,
            watermark=["removed"],
        )
        isolated.append(post_id)

        migrate(apply_changes=True)

        s = state(db, post_id)
        assert s["likeDocs"] == ["tail"], "tail created, removal preserved"
        assert s["likesCount"] == 1
        assert s["watermark"] == ["removed", "tail"]

    def test_a_tail_like_survives_repeated_runs(self, db, isolated):
        post_id = make_post(
            db, "m_tail_idem",
            liked_by=["early", "tail"], like_docs=["early"],
            likes_count=2, watermark=["early"],
        )
        isolated.append(post_id)

        migrate(apply_changes=True)
        after_first = state(db, post_id)
        migrate(apply_changes=True)
        assert state(db, post_id) == after_first


class TestOldClientUnlike:
    def test_a_stale_document_is_reported_but_not_deleted_by_default(self, db, isolated):
        # Unliked on an old client: array entry gone, document left behind.
        post_id = make_post(
            db, "m_stale",
            liked_by=[], like_docs=["lingerer"], likes_count=1, watermark=["lingerer"],
        )
        isolated.append(post_id)

        migrate(apply_changes=True)

        s = state(db, post_id)
        assert s["likeDocs"] == ["lingerer"], "not deleted without --prune-stale"
        assert s["likesCount"] == 1, "the counter follows the documents"

    def test_prune_stale_removes_it_when_asked(self, db, isolated):
        post_id = make_post(
            db, "m_prune",
            liked_by=[], like_docs=["lingerer"], likes_count=1, watermark=["lingerer"],
        )
        isolated.append(post_id)

        migrate(apply_changes=True, prune_stale=True)

        s = state(db, post_id)
        assert s["likeDocs"] == []
        assert s["likesCount"] == 0

    def test_prune_stale_is_still_a_dry_run_without_apply(self, db, isolated):
        post_id = make_post(
            db, "m_prune_dry",
            liked_by=[], like_docs=["lingerer"], likes_count=1, watermark=["lingerer"],
        )
        isolated.append(post_id)

        migrate(apply_changes=False, prune_stale=True)
        assert state(db, post_id)["likeDocs"] == ["lingerer"]


class TestUnrelatedFieldsAreUntouched:
    def test_migration_does_not_modify_other_post_fields(self, db, isolated):
        post_id = "m_fields"
        db.collection("posts").document(post_id).set({
            "authorId": "author", "content": "a caption", "category": "vintage",
            "imageUrl": "https://example.com/x.jpg", "commentsCount": 7,
            "analyzed": True, "analysisStatus": "complete", "aesthetic": "vintage",
            "likedBy": ["a"], "likesCount": 1,
            "createdAt": NOW - timedelta(days=1),
        })
        isolated.append(post_id)

        migrate(apply_changes=True)

        data = db.collection("posts").document(post_id).get().to_dict()
        assert data["content"] == "a caption"
        assert data["commentsCount"] == 7
        assert data["analyzed"] is True
        assert data["analysisStatus"] == "complete"
        assert data["aesthetic"] == "vintage"
        assert data["authorId"] == "author"

    def test_migration_never_duplicates_a_like_document(self, db, isolated):
        post_id = make_post(db, "m_nodupe", liked_by=["a", "a", "a"], likes_count=3)
        isolated.append(post_id)

        migrate(apply_changes=True)
        migrate(apply_changes=True)

        s = state(db, post_id)
        assert s["likeDocs"] == ["a"]
        assert s["likesCount"] == 1


class TestVerify:
    def test_verify_fails_on_a_genuinely_unmigrated_liker(self, db, isolated):
        post_id = make_post(db, "v_unmigrated", liked_by=["a"], likes_count=1)
        isolated.append(post_id)
        assert verify() == 1

    def test_verify_fails_on_a_count_mismatch(self, db, isolated):
        post_id = make_post(
            db, "v_count", liked_by=["a"], like_docs=["a"],
            likes_count=42, watermark=["a"],
        )
        isolated.append(post_id)
        assert verify() == 1

    def test_verify_passes_after_a_clean_migration(self, db, isolated):
        post_id = make_post(db, "v_clean", liked_by=["a", "b"], likes_count=2)
        isolated.append(post_id)

        migrate(apply_changes=True)
        assert verify() == 0
