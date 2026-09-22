"""The pre-migration backup, and the verification that makes it trustworthy.

A backup nobody verified is a backup nobody has, so the verify path gets more
attention here than the export path: it has to notice truncation, corruption
and a missing file, because those are the failures that stay silent until the
day you need the data.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

import export_firestore
from export_firestore import MANIFEST, export, verify

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture
def seeded(db, monkeypatch):
    monkeypatch.setattr(export_firestore, "get_db", lambda: db)
    prefix = f"exp_{uuid.uuid4().hex[:8]}"
    created = []

    post_id = f"{prefix}_post"
    db.collection("posts").document(post_id).set({
        "authorId": "author", "content": "a caption", "likesCount": 2,
        "likedBy": ["u1", "u2"], "createdAt": NOW - timedelta(days=1),
    })
    for uid in ("u1", "u2"):
        (db.collection("posts").document(post_id)
           .collection("likes").document(uid).set({"uid": uid, "createdAt": NOW}))
    created.append(("posts", post_id, ["likes"]))

    user_id = f"{prefix}_user"
    db.collection("users").document(user_id).set({"email": "a@example.com"})
    (db.collection("users").document(user_id)
       .collection("interactions").document("impression_x")
       .set({"postId": "x", "type": "impression", "createdAt": "now", "schemaVersion": 1}))
    created.append(("users", user_id, ["interactions"]))

    yield prefix

    for coll, doc_id, subs in created:
        ref = db.collection(coll).document(doc_id)
        for sub in subs:
            for d in ref.collection(sub).stream():
                d.reference.delete()
        ref.delete()


class TestExport:
    def test_writes_a_manifest_and_files(self, tmp_path, seeded):
        out = tmp_path / "backup"
        assert export(str(out)) == 0

        manifest = json.loads((out / MANIFEST).read_text(encoding="utf8"))
        assert manifest["totalDocuments"] > 0
        assert "posts" in manifest["files"]
        assert (out / "posts.ndjson").exists()

    def test_captures_subcollections(self, tmp_path, seeded):
        out = tmp_path / "backup"
        export(str(out))

        likes = (out / "posts__likes.ndjson").read_text(encoding="utf8")
        assert "u1" in likes and "u2" in likes
        interactions = (out / "users__interactions.ndjson").read_text(encoding="utf8")
        assert "impression_x" in interactions

    def test_timestamps_survive_the_round_trip(self, tmp_path, seeded):
        out = tmp_path / "backup"
        export(str(out))

        rows = [json.loads(line) for line in
                (out / "posts.ndjson").read_text(encoding="utf8").splitlines() if line]
        created = [r["data"]["createdAt"] for r in rows if "createdAt" in r["data"]]
        assert created, "no createdAt captured"
        assert created[0]["__type__"] == "timestamp"
        # And it parses back as a real datetime.
        datetime.fromisoformat(created[0]["value"])

    def test_refuses_to_overwrite_an_existing_backup(self, tmp_path, seeded):
        out = tmp_path / "backup"
        assert export(str(out)) == 0
        # A second export into the same directory would destroy the first.
        assert export(str(out)) == 1

    def test_writes_nothing_to_firestore(self, db, tmp_path, seeded):
        post_id = f"{seeded}_post"
        before = db.collection("posts").document(post_id).get().to_dict()
        export(str(tmp_path / "backup"))
        after = db.collection("posts").document(post_id).get().to_dict()
        assert before == after


class TestVerify:
    @pytest.fixture
    def backup(self, tmp_path, seeded):
        out = tmp_path / "backup"
        export(str(out))
        return out

    def test_a_good_backup_verifies(self, backup):
        assert verify(str(backup)) == 0

    def test_a_missing_manifest_fails(self, tmp_path):
        empty = tmp_path / "nothing"
        empty.mkdir()
        assert verify(str(empty)) == 1

    def test_a_truncated_file_fails(self, backup):
        path = backup / "posts.ndjson"
        lines = path.read_text(encoding="utf8").splitlines()
        path.write_text("\n".join(lines[:-1]) + "\n", encoding="utf8")
        assert verify(str(backup)) == 1

    def test_a_corrupted_file_fails(self, backup):
        path = backup / "posts.ndjson"
        text = path.read_text(encoding="utf8")
        path.write_text(text.replace("a caption", "TAMPERED"), encoding="utf8")
        assert verify(str(backup)) == 1

    def test_a_deleted_file_fails(self, backup):
        (backup / "posts.ndjson").unlink()
        assert verify(str(backup)) == 1

    def test_unparseable_content_fails(self, backup):
        manifest = json.loads((backup / MANIFEST).read_text(encoding="utf8"))
        path = backup / "posts.ndjson"
        path.write_text("{not json\n", encoding="utf8")
        # Re-point the manifest so it fails on parsing, not on the hash.
        import hashlib
        manifest["files"]["posts"] = {
            "documents": 1,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        (backup / MANIFEST).write_text(json.dumps(manifest), encoding="utf8")
        assert verify(str(backup)) == 1
