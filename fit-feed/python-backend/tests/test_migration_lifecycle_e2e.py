"""The full old-client-unlike lifecycle, end to end.

The transitional window lets two clients write likes through two different
mechanisms, and the awkward case is an OLD client unliking a post the
migration already backfilled:

    the old client removes the uid from likedBy and decrements the counter,
    but it cannot delete posts/{id}/likes/{uid} - no client rule permits
    touching another representation of the like.

That leaves `uid in M, uid not in L, uid in D`: the user has unliked, and the
new client would still show the post as liked, because the like document is
what the new client reads. Only the Admin SDK can clean that up, which makes
--prune-stale a correctness requirement of Phase G rather than a nicety.

This module walks that lifecycle and the four neighbouring cases that must
keep working alongside it.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

import migrate_likes
import reconcile_likes
from feed_service import attach_liked_by_me, serialize_post
from migrate_likes import WATERMARK_FIELD, migrate, verify

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
ALICE = "alice_uid"


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture(autouse=True)
def clean(db, monkeypatch):
    """A single-post world, so the whole-collection scans stay deterministic."""
    monkeypatch.setattr(migrate_likes, "get_db", lambda: db)
    monkeypatch.setattr(reconcile_likes, "get_db", lambda: db)

    def wipe():
        for post in db.collection("posts").stream():
            for like in post.reference.collection("likes").stream():
                like.reference.delete()
            post.reference.delete()

    wipe()
    yield
    wipe()


POST = "lifecycle_post"


def seed_legacy_post(db, liked_by):
    """A post as production has it today: array + counter, no like documents."""
    db.collection("posts").document(POST).set({
        "authorId": "author", "category": "streetwear", "content": "a caption",
        "likedBy": list(liked_by), "likesCount": len(liked_by),
        "createdAt": NOW - timedelta(days=2),
    })


def state(db):
    ref = db.collection("posts").document(POST)
    data = ref.get().to_dict() or {}
    return {
        "L": sorted(data.get("likedBy") or []),
        "M": sorted(data.get(WATERMARK_FIELD) or []),
        "D": sorted(d.id for d in ref.collection("likes").stream()),
        "count": data.get("likesCount"),
    }


def legacy_unlike(db, uid):
    """Exactly what the deployed client does, and all it can do.

    The transitional rules permit precisely this shape:
        { likesCount: increment(-1), likedBy: arrayRemove(uid) }
    It cannot touch the likes subcollection.
    """
    db.collection("posts").document(POST).update({
        "likedBy": gcf.ArrayRemove([uid]),
        "likesCount": gcf.Increment(-1),
    })


def legacy_like(db, uid):
    db.collection("posts").document(POST).update({
        "likedBy": gcf.ArrayUnion([uid]),
        "likesCount": gcf.Increment(1),
    })


def new_client_unlike(db, uid):
    """What the migrated client does: delete the document, move the counter."""
    (db.collection("posts").document(POST)
       .collection("likes").document(uid).delete())
    db.collection("posts").document(POST).update({"likesCount": gcf.Increment(-1)})


def liked_by_me(db, uid) -> bool:
    """What the backend would tell this viewer, through the real code path."""
    ref = db.collection("posts").document(POST)
    data = ref.get().to_dict() or {}
    post = serialize_post(POST, data, uid)
    attach_liked_by_me(db, [post], uid)
    return bool(post.get("likedByMe"))


# ===================================================================== case 1


class TestOldClientUnlikeLifecycle:
    """The case the gate is about, start to finish."""

    def test_the_complete_lifecycle(self, db):
        # --- 1. a legacy like exists before any of this starts
        seed_legacy_post(db, [ALICE])
        assert state(db) == {"L": [ALICE], "M": [], "D": [], "count": 1}

        # --- 2. Phase D: the initial migration
        assert migrate(apply_changes=True) == 0
        after_migration = state(db)
        assert ALICE in after_migration["M"], "the watermark must record the migration"
        assert after_migration["D"] == [ALICE], "the like document must exist"
        assert after_migration["count"] == 1
        assert verify() == 0
        assert liked_by_me(db, ALICE) is True, "the new client should see it as liked"

        # --- 3/4/5. an old client unlikes, under the transitional rules
        legacy_unlike(db, ALICE)
        after_unlike = state(db)
        assert after_unlike["L"] == [], "the array entry is gone"
        assert after_unlike["count"] == 0, "the legacy counter decremented"

        # --- 6. the old client could not delete the like document
        assert after_unlike["D"] == [ALICE], "the document survives, which is the problem"
        assert liked_by_me(db, ALICE) is True, \
            "before cleanup the new client still shows it liked - this is the bug " \
            "Phase G must close"

        # --- Phase G: the prune is what actually resolves it
        assert migrate(apply_changes=True, prune_stale=True) == 0
        after_prune = state(db)
        assert after_prune["D"] == [], "the stale document is removed"
        assert after_prune["count"] == 0, "the counter agrees with the documents"
        assert after_prune["L"] == [], "likedBy is untouched by the prune"

        # --- the new client now reflects reality
        assert liked_by_me(db, ALICE) is False
        assert liked_by_me(db, ALICE) is False, "a reload stays false"

        # --- reconciliation does not bring it back
        assert reconcile_likes.reconcile_counts(db, apply_changes=True)["fixed"] == 0
        reconcile_likes.sweep_orphans(db, apply_changes=True)
        assert state(db)["D"] == []
        assert liked_by_me(db, ALICE) is False

        # --- and neither does another full migration pass
        assert migrate(apply_changes=True) == 0
        assert state(db)["D"] == [], "a later --apply must not recreate it"
        assert migrate(apply_changes=True, prune_stale=True) == 0
        assert state(db)["D"] == []

        # --- verify is clean, so Phase H may proceed
        assert verify() == 0
        final = state(db)
        assert final["count"] == len(final["D"]) == 0

    def test_without_prune_the_user_stays_liked(self, db):
        """Why --prune-stale is required, not optional, stated as a test."""
        seed_legacy_post(db, [ALICE])
        migrate(apply_changes=True)
        legacy_unlike(db, ALICE)

        # Phase G without the prune: the migration reports it but leaves it.
        migrate(apply_changes=True)

        assert state(db)["D"] == [ALICE]
        assert liked_by_me(db, ALICE) is True, \
            "the user unliked, yet the new client still shows liked - " \
            "this is exactly what the runbook must prevent"

    def test_the_counter_never_disagrees_with_the_documents(self, db):
        seed_legacy_post(db, [ALICE, "bob_uid"])
        migrate(apply_changes=True)
        legacy_unlike(db, ALICE)
        migrate(apply_changes=True, prune_stale=True)

        final = state(db)
        assert final["count"] == len(final["D"]) == 1
        assert final["D"] == ["bob_uid"]


# ================================================================== cases A-D


class TestNeighbouringCases:
    def test_A_new_client_unlike_is_not_resurrected(self, db):
        """M has uid, L still has the stale uid, D deleted. Must stay deleted."""
        seed_legacy_post(db, [ALICE])
        migrate(apply_changes=True)
        new_client_unlike(db, ALICE)

        before = state(db)
        assert before["M"] == [ALICE] and before["L"] == [ALICE] and before["D"] == []

        # Phase G, including the prune, must not recreate it.
        assert migrate(apply_changes=True, prune_stale=True) == 0
        after = state(db)
        assert after["D"] == [], "an intentional removal must not come back"
        assert after["count"] == 0
        assert liked_by_me(db, ALICE) is False
        assert verify() == 0

    def test_B_old_client_unlike_then_relike_keeps_the_document(self, db):
        """M has uid, L ends WITH uid, D exists. The prune must not delete it."""
        seed_legacy_post(db, [ALICE])
        migrate(apply_changes=True)
        legacy_unlike(db, ALICE)
        legacy_like(db, ALICE)          # re-liked before the window closed

        before = state(db)
        assert before["M"] == [ALICE] and before["L"] == [ALICE] and before["D"] == [ALICE]

        assert migrate(apply_changes=True, prune_stale=True) == 0
        after = state(db)
        assert after["D"] == [ALICE], "a re-liked post must keep its like document"
        assert after["count"] == 1
        assert liked_by_me(db, ALICE) is True
        assert verify() == 0

    def test_C_tail_window_like_from_a_new_user_is_created(self, db):
        """L has uid, M does not, D absent. Phase G must create D."""
        seed_legacy_post(db, [])
        migrate(apply_changes=True)     # watermark recorded as empty
        legacy_like(db, "newcomer")     # an old client likes during the window

        before = state(db)
        assert before["M"] == [] and before["L"] == ["newcomer"] and before["D"] == []

        assert migrate(apply_changes=True, prune_stale=True) == 0
        after = state(db)
        assert after["D"] == ["newcomer"], "a legitimate tail-window like must be kept"
        assert after["count"] == 1
        assert liked_by_me(db, "newcomer") is True
        assert verify() == 0

    def test_D_tail_window_like_then_unlike_does_nothing(self, db):
        """Not in M, L ends without uid, D absent. Phase G is a no-op."""
        seed_legacy_post(db, [])
        migrate(apply_changes=True)
        legacy_like(db, "transient")
        legacy_unlike(db, "transient")

        before = state(db)
        assert before["L"] == [] and before["D"] == []

        assert migrate(apply_changes=True, prune_stale=True) == 0
        after = state(db)
        assert after["D"] == [], "nothing to create, nothing to prune"
        assert after["count"] == 0
        assert liked_by_me(db, "transient") is False
        assert verify() == 0

    def test_all_four_cases_on_one_post_simultaneously(self, db):
        """The realistic end state: every case present at once."""
        seed_legacy_post(db, ["old_unliker", "new_unliker", "relikers"])
        migrate(apply_changes=True)

        legacy_unlike(db, "old_unliker")        # case 1
        new_client_unlike(db, "new_unliker")    # case A
        legacy_unlike(db, "relikers")
        legacy_like(db, "relikers")             # case B
        legacy_like(db, "tail")                 # case C
        legacy_like(db, "transient")
        legacy_unlike(db, "transient")          # case D

        assert migrate(apply_changes=True, prune_stale=True) == 0

        final = state(db)
        assert final["D"] == ["relikers", "tail"], (
            "old-client unlike pruned, new-client unlike not resurrected, "
            "re-like kept, tail-window like created, transient ignored"
        )
        assert final["count"] == len(final["D"]) == 2
        assert liked_by_me(db, "old_unliker") is False
        assert liked_by_me(db, "new_unliker") is False
        assert liked_by_me(db, "relikers") is True
        assert liked_by_me(db, "tail") is True
        assert liked_by_me(db, "transient") is False
        assert verify() == 0


class TestPhaseGIsIdempotent:
    def test_running_the_phase_g_sequence_twice_changes_nothing(self, db):
        seed_legacy_post(db, ["old_unliker", "keeper"])
        migrate(apply_changes=True)
        legacy_unlike(db, "old_unliker")
        legacy_like(db, "tail")

        migrate(apply_changes=True, prune_stale=True)
        reconcile_likes.reconcile_counts(db, apply_changes=True)
        first = state(db)

        migrate(apply_changes=True, prune_stale=True)
        reconcile_likes.reconcile_counts(db, apply_changes=True)
        assert state(db) == first
        assert verify() == 0
