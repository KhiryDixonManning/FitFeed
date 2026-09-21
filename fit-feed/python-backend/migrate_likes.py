#!/usr/bin/env python
"""Migrate likes from the legacy posts.likedBy array to a subcollection.

    before   posts/{postId}.likedBy = [uid, uid, ...]   (unbounded array)
    after    posts/{postId}/likes/{uid} = {uid, createdAt}

The document id is the uid, so "one like per user per post" becomes a
property of the schema rather than something to enforce, and the post
document stops growing with its audience.

Safety properties:
  * Dry run by default; --apply performs writes.
  * Idempotent: a like document that already exists is left untouched, so
    running twice changes nothing the second time.
  * Non-destructive: likedBy is NOT deleted. It is kept as the rollback path
    until --verify reports a clean run. Removing it is a separate, later
    decision (see the sequence below).
  * Reconciles likesCount to the number of distinct likers, and reports any
    post where the stored count disagreed.
  * No Anthropic calls.

This must run BEFORE the client that reads the subcollection is deployed.

No client falls back to the array: the rules do not let a client write
likedBy, so it cannot remove itself from one, and a like that exists only in
the array would read as "not liked". Pressing the heart would then create a
like document on top of the array entry and count the same person twice.
Backfilling first makes that impossible - the transaction sees the existing
like document and unlikes instead.

Recommended sequence:
    python migrate_likes.py                 # inspect the plan
    python migrate_likes.py --apply         # create like documents
    python migrate_likes.py --verify        # prove docs == likesCount
    # ... deploy the client, then, only after a clean verify, consider
    #     dropping likedBy in a separate change.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone

from auth import get_db

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("migrate-likes")

LIKES_SUBCOLLECTION = "likes"
BATCH_LIMIT = 400


def _distinct_likers(raw) -> list[str]:
    if not isinstance(raw, list):
        return []
    seen: list[str] = []
    for entry in raw:
        if isinstance(entry, str) and entry and entry not in seen:
            seen.append(entry)
    return seen


def migrate(apply_changes: bool) -> int:
    db = get_db()
    if db is None:
        log.error("No Firebase credentials. Set GOOGLE_CREDENTIALS_JSON or "
                  "provide serviceAccountKey.json.")
        return 1

    now = datetime.now(timezone.utc)
    posts = list(db.collection("posts").stream())
    log.info("Scanning %d posts", len(posts))

    created = skipped = reconciled = anomalies = 0

    for post_doc in posts:
        data = post_doc.to_dict() or {}
        likers = _distinct_likers(data.get("likedBy"))
        raw_len = len(data.get("likedBy") or []) if isinstance(data.get("likedBy"), list) else 0
        stored_count = data.get("likesCount")

        if raw_len != len(likers):
            anomalies += 1
            log.warning("ANOMALY %s: likedBy had %d entries, %d distinct",
                        post_doc.id, raw_len, len(likers))

        likes_ref = post_doc.reference.collection(LIKES_SUBCOLLECTION)
        existing = {d.id for d in likes_ref.stream()}

        missing = [uid for uid in likers if uid not in existing]
        if missing:
            created += len(missing)
            log.info("CREATE %s: %d like documents", post_doc.id, len(missing))
            if apply_changes:
                for chunk_start in range(0, len(missing), BATCH_LIMIT):
                    batch = db.batch()
                    for uid in missing[chunk_start:chunk_start + BATCH_LIMIT]:
                        batch.set(likes_ref.document(uid), {"uid": uid, "createdAt": now})
                    batch.commit()
        else:
            skipped += 1

        # The count should equal the number of distinct like documents.
        target = len(existing | set(likers))
        if not isinstance(stored_count, int) or stored_count != target:
            reconciled += 1
            log.info("RECONCILE %s: likesCount %r -> %d", post_doc.id, stored_count, target)
            if apply_changes:
                post_doc.reference.update({"likesCount": target})

    verb = "Applied" if apply_changes else "Planned (dry run)"
    log.info("%s: %d like documents, %d counts reconciled, %d posts already current, "
             "%d anomalies", verb, created, reconciled, skipped, anomalies)
    if not apply_changes:
        log.info("Re-run with --apply to perform these writes.")
    log.info("likedBy was NOT modified or removed.")
    return 0


def verify() -> int:
    """Post-migration check: like documents == likesCount, for every post."""
    db = get_db()
    if db is None:
        log.error("No Firebase credentials.")
        return 1

    posts = list(db.collection("posts").stream())
    log.info("Verifying %d posts", len(posts))

    mismatches = missing_docs = 0

    for post_doc in posts:
        data = post_doc.to_dict() or {}
        like_ids = {d.id for d in post_doc.reference.collection(LIKES_SUBCOLLECTION).stream()}
        stored_count = data.get("likesCount")
        legacy = set(_distinct_likers(data.get("likedBy")))

        if not isinstance(stored_count, int) or stored_count != len(like_ids):
            mismatches += 1
            log.error("MISMATCH %s: %d like documents but likesCount=%r",
                      post_doc.id, len(like_ids), stored_count)

        not_migrated = legacy - like_ids
        if not_migrated:
            missing_docs += 1
            log.error("UNMIGRATED %s: %d legacy likers have no like document",
                      post_doc.id, len(not_migrated))

    if mismatches or missing_docs:
        log.error("VERIFY FAILED: %d count mismatches, %d posts with unmigrated likers",
                  mismatches, missing_docs)
        log.error("Do NOT remove likedBy until this reports clean.")
        return 1

    log.info("VERIFY OK: every post has like documents matching likesCount, "
             "and every legacy liker was migrated.")
    log.info("Removing likedBy is now safe to consider as a separate change.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="perform writes (default: dry run)")
    parser.add_argument("--verify", action="store_true",
                        help="check like documents against likesCount and exit")
    args = parser.parse_args()

    if args.verify:
        return verify()
    return migrate(args.apply)


if __name__ == "__main__":
    sys.exit(main())
