#!/usr/bin/env python
"""Migrate likes from the legacy posts.likedBy array to a subcollection.

    before   posts/{postId}.likedBy = [uid, uid, ...]   (unbounded array)
    after    posts/{postId}/likes/{uid} = {uid, createdAt}

The document id is the uid, so "one like per user per post" becomes a
property of the schema rather than something to enforce, and the post
document stops growing with its audience.

THE WATERMARK, AND WHY IT EXISTS
--------------------------------
This runs at least twice: once before the new client ships, and once at the
end of the compatibility window to pick up likes the OLD client wrote during
it. On that second run, a uid sitting in likedBy with no like document is
ambiguous - it has two possible histories:

  (A) a legitimate tail-window legacy like: the old client added it to the
      array AFTER the first migration, and it needs a like document;
  (B) an intentionally removed like: the first migration created the
      document, and the user then unliked on the new client, which deletes
      the document but CANNOT remove the array entry (no client may write
      likedBy).

Backfilling (B) resurrects a like the user deliberately removed and
re-increments the counter. Refusing to backfill (A) silently loses a real
like. The two are indistinguishable from likedBy alone.

So the first apply records a watermark on each post:

    posts/{postId}.likedByMigrated = [...]   snapshot of likedBy at that time

which makes the distinction exact. With M = likedByMigrated, L = likedBy and
D = the like document ids:

    u in L, not in M, not in D   -> (A) tail-window like        CREATE
    u in M, in L, not in D       -> (B) intentionally removed   LEAVE ALONE
    u in M, in D, not in L       -> old-client unlike           REPORT
    everything else              -> already consistent          NOTHING

likedByMigrated is server-owned: no client rule permits writing it, and it is
deleted alongside likedBy during cleanup.

Safety properties:
  * Dry run by default; --apply performs writes.
  * Idempotent: running twice changes nothing the second time.
  * Non-destructive: likedBy is NOT deleted. It is the rollback path until
    --verify reports clean. Removing it is a separate, later decision.
  * Never resurrects an intentionally removed like (see the watermark above).
  * Reconciles likesCount to the number of like DOCUMENTS, which is the
    source of truth, not to the length of the legacy array.
  * No Anthropic calls.

This must run BEFORE the client that reads the subcollection is deployed.

Recommended sequence:
    python migrate_likes.py                 # inspect the plan
    python migrate_likes.py --apply         # create like documents
    python migrate_likes.py --verify        # prove docs == likesCount
    # ... deploy, run the window, then at the end of it:
    python migrate_likes.py --apply         # pick up tail-window likes
    python migrate_likes.py --verify        # must be clean before strict rules
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone
from typing import Optional

from auth import get_db

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("migrate-likes")

LIKES_SUBCOLLECTION = "likes"
WATERMARK_FIELD = "likedByMigrated"
BATCH_LIMIT = 400


def _distinct_likers(raw) -> list[str]:
    """Distinct, non-empty string uids, in first-seen order."""
    if not isinstance(raw, list):
        return []
    seen: list[str] = []
    for entry in raw:
        if isinstance(entry, str) and entry and entry not in seen:
            seen.append(entry)
    return seen


def classify(post_data: dict, like_doc_ids: set[str]) -> dict:
    """Decide what this post needs, from the three sets.

    Pure, so the decision table above is directly testable without Firestore.
    """
    legacy = _distinct_likers(post_data.get("likedBy"))
    raw = post_data.get(WATERMARK_FIELD)
    first_run = not isinstance(raw, list)
    watermark = set(_distinct_likers(raw))

    legacy_set = set(legacy)

    if first_run:
        # Nothing has been migrated yet: every legacy liker still needs a
        # document. There is no ambiguity to resolve on a first run.
        to_create = [uid for uid in legacy if uid not in like_doc_ids]
        intentionally_removed: set[str] = set()
    else:
        # Only likers the previous run did NOT already account for. Dropping
        # the watermark term here is exactly the resurrection bug: it would
        # recreate a like the user removed on the new client after migration.
        to_create = [
            uid for uid in legacy
            if uid not in watermark and uid not in like_doc_ids
        ]
        # In the array and previously migrated, but the document is gone:
        # the user unliked on the new client. Leave it removed.
        intentionally_removed = (watermark & legacy_set) - like_doc_ids

    # Previously migrated, document still present, but gone from the array:
    # the user unliked on an OLD client, which cannot delete the document.
    stale_documents = (watermark & like_doc_ids) - legacy_set

    return {
        "legacy": legacy,
        "first_run": first_run,
        "to_create": to_create,
        "intentionally_removed": sorted(intentionally_removed),
        "stale_documents": sorted(stale_documents),
        "next_watermark": sorted(watermark | legacy_set),
    }


def migrate(apply_changes: bool, prune_stale: bool = False) -> int:
    db = get_db()
    if db is None:
        log.error("No Firebase credentials. Set GOOGLE_CREDENTIALS_JSON or "
                  "provide serviceAccountKey.json.")
        return 1

    now = datetime.now(timezone.utc)
    posts = list(db.collection("posts").stream())
    log.info("Scanning %d posts", len(posts))

    created = skipped = reconciled = anomalies = 0
    preserved_removals = stale_seen = pruned = 0

    for post_doc in posts:
        data = post_doc.to_dict() or {}
        likes_ref = post_doc.reference.collection(LIKES_SUBCOLLECTION)
        existing = {d.id for d in likes_ref.stream()}

        raw_len = len(data.get("likedBy") or []) if isinstance(data.get("likedBy"), list) else 0
        plan = classify(data, existing)

        if raw_len != len(plan["legacy"]):
            anomalies += 1
            log.warning("ANOMALY %s: likedBy had %d entries, %d distinct",
                        post_doc.id, raw_len, len(plan["legacy"]))

        if plan["intentionally_removed"]:
            preserved_removals += len(plan["intentionally_removed"])
            log.info("PRESERVE %s: %d like(s) removed after migration stay removed",
                     post_doc.id, len(plan["intentionally_removed"]))

        if plan["stale_documents"]:
            stale_seen += len(plan["stale_documents"])
            log.warning(
                "STALE %s: %d like document(s) whose liker left likedBy "
                "(unliked on an old client). %s",
                post_doc.id, len(plan["stale_documents"]),
                "Pruning." if prune_stale else "Not pruning; pass --prune-stale to remove.",
            )

        final_ids = set(existing)

        to_create = plan["to_create"]
        if to_create:
            created += len(to_create)
            log.info("CREATE %s: %d like document(s)", post_doc.id, len(to_create))
            if apply_changes:
                for start in range(0, len(to_create), BATCH_LIMIT):
                    batch = db.batch()
                    for uid in to_create[start:start + BATCH_LIMIT]:
                        batch.set(likes_ref.document(uid), {"uid": uid, "createdAt": now})
                    batch.commit()
            final_ids |= set(to_create)
        elif not plan["stale_documents"]:
            skipped += 1

        if prune_stale and plan["stale_documents"]:
            pruned += len(plan["stale_documents"])
            if apply_changes:
                for start in range(0, len(plan["stale_documents"]), BATCH_LIMIT):
                    batch = db.batch()
                    for uid in plan["stale_documents"][start:start + BATCH_LIMIT]:
                        batch.delete(likes_ref.document(uid))
                    batch.commit()
            final_ids -= set(plan["stale_documents"])

        # The counter follows the DOCUMENTS, never the legacy array - an
        # intentionally removed like must not be counted back in.
        target = len(final_ids)
        stored_count = data.get("likesCount")
        needs_count = not isinstance(stored_count, int) or stored_count != target

        updates = {}
        if needs_count:
            reconciled += 1
            log.info("RECONCILE %s: likesCount %r -> %d", post_doc.id, stored_count, target)
            updates["likesCount"] = target

        # Advance the watermark so the next run can tell (A) from (B).
        if plan["next_watermark"] != sorted(set(_distinct_likers(data.get(WATERMARK_FIELD)))) \
                or plan["first_run"]:
            updates[WATERMARK_FIELD] = plan["next_watermark"]

        if updates and apply_changes:
            post_doc.reference.update(updates)

    verb = "Applied" if apply_changes else "Planned (dry run)"
    log.info("%s: %d like documents created, %d counts reconciled, "
             "%d posts already current, %d anomalies",
             verb, created, reconciled, skipped, anomalies)
    if preserved_removals:
        log.info("%d like(s) intentionally removed after migration were left removed.",
                 preserved_removals)
    if stale_seen:
        log.warning("%d stale like document(s) seen; %d pruned.", stale_seen, pruned)
    if not apply_changes:
        log.info("Re-run with --apply to perform these writes.")
    log.info("likedBy was NOT modified or removed.")
    return 0


def verify() -> int:
    """Post-migration check: like documents == likesCount, for every post.

    A legacy liker with no like document only counts as unmigrated if the
    watermark says we never migrated them. One we DID migrate and who no
    longer has a document unliked deliberately, and must not fail the check -
    otherwise --verify could never go clean after the cutover.
    """
    db = get_db()
    if db is None:
        log.error("No Firebase credentials.")
        return 1

    posts = list(db.collection("posts").stream())
    log.info("Verifying %d posts", len(posts))

    mismatches = missing_docs = stale = 0

    for post_doc in posts:
        data = post_doc.to_dict() or {}
        like_ids = {d.id for d in post_doc.reference.collection(LIKES_SUBCOLLECTION).stream()}
        stored_count = data.get("likesCount")
        plan = classify(data, like_ids)

        if not isinstance(stored_count, int) or stored_count != len(like_ids):
            mismatches += 1
            log.error("MISMATCH %s: %d like documents but likesCount=%r",
                      post_doc.id, len(like_ids), stored_count)

        if plan["to_create"]:
            missing_docs += 1
            log.error("UNMIGRATED %s: %d legacy liker(s) have no like document "
                      "and were never migrated", post_doc.id, len(plan["to_create"]))

        if plan["stale_documents"]:
            stale += 1
            log.warning("STALE %s: %d like document(s) left by an old-client unlike",
                        post_doc.id, len(plan["stale_documents"]))

    if mismatches or missing_docs:
        log.error("VERIFY FAILED: %d count mismatches, %d posts with unmigrated likers",
                  mismatches, missing_docs)
        log.error("Do NOT remove likedBy until this reports clean.")
        return 1

    if stale:
        log.warning("VERIFY OK with %d post(s) holding stale like documents. "
                    "Run with --prune-stale --apply to reconcile them.", stale)
    log.info("VERIFY OK: like documents match likesCount, and every legacy liker "
             "was either migrated or intentionally removed afterwards.")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="perform writes (default: dry run)")
    parser.add_argument("--verify", action="store_true",
                        help="check like documents against likesCount and exit")
    parser.add_argument("--prune-stale", action="store_true",
                        help="also delete like documents whose liker left likedBy "
                             "via an old client (off by default: it deletes data)")
    args = parser.parse_args(argv)

    if args.verify:
        return verify()
    return migrate(args.apply, prune_stale=args.prune_stale)


if __name__ == "__main__":
    sys.exit(main())
