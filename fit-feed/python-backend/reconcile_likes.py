#!/usr/bin/env python
"""Reconcile like documents against likesCount, and sweep orphaned likes.

Two drift sources the like architecture cannot close on its own:

1. ORPHANED LIKE DOCUMENTS. Firestore does not cascade-delete subcollections,
   and the rules only let a user delete their OWN like document - so when an
   author deletes a post, other people's likes under it survive as garbage.
   They are unreachable from the UI and cannot corrupt a count (the post is
   gone), but they consume the taste-rebuild budget and grow without bound.
   Only the Admin SDK can remove them, which is why this is a maintenance
   job rather than client cleanup.

2. COUNTER DRIFT. likesCount is denormalised. The rules make it very hard to
   move dishonestly - a step of one, paired with the caller's own like
   document appearing or disappearing, verified against post-commit state -
   but they permit deleting a like document WITHOUT decrementing, and a
   partial legacy write during the migration window could in principle leave
   the two disagreeing. This recounts and reports.

Dry run by default, like every other migration tool here. Nothing is written
without --apply, and --apply never deletes a like belonging to a post that
still exists.

    python reconcile_likes.py                  # report only
    python reconcile_likes.py --apply          # fix counts, sweep orphans
    python reconcile_likes.py --counts-only    # skip the orphan sweep
"""

from __future__ import annotations

import argparse
import logging
import sys
from typing import Optional

from auth import get_db

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("reconcile_likes")

LIKES_SUBCOLLECTION = "likes"

# Bound a single run so a maintenance job cannot become an unbounded scan.
MAX_POSTS = 5000
MAX_ORPHAN_DELETES = 5000


def count_likes(post_ref) -> int:
    """Number of like documents under a post."""
    return sum(1 for _ in post_ref.collection(LIKES_SUBCOLLECTION).list_documents())


def reconcile_counts(db, apply_changes: bool, limit: int = MAX_POSTS) -> dict:
    """Recount likes per post and realign likesCount where it disagrees."""
    checked = drifted = fixed = 0

    for post in db.collection("posts").limit(limit).stream():
        checked += 1
        data = post.to_dict() or {}

        stored = data.get("likesCount")
        if not isinstance(stored, int) or isinstance(stored, bool):
            stored = 0
        actual = count_likes(post.reference)

        if stored == actual:
            continue

        drifted += 1
        log.warning("DRIFT post=%s likesCount=%s like_documents=%s", post.id, stored, actual)
        if apply_changes:
            post.reference.update({"likesCount": actual})
            fixed += 1

    return {"checked": checked, "drifted": drifted, "fixed": fixed}


def sweep_orphans(db, apply_changes: bool, limit: int = MAX_ORPHAN_DELETES) -> dict:
    """Delete like documents whose post no longer exists.

    Walks the likes collection group and checks each parent. A like is only
    ever removed when its post is genuinely absent - a missing post is the
    single condition under which a like has no meaning.
    """
    scanned = orphaned = deleted = 0
    live_posts: dict[str, bool] = {}

    for like in db.collection_group(LIKES_SUBCOLLECTION).limit(limit).stream():
        scanned += 1
        post_ref = like.reference.parent.parent
        if post_ref is None:
            continue

        if post_ref.id not in live_posts:
            live_posts[post_ref.id] = post_ref.get().exists
        if live_posts[post_ref.id]:
            continue

        orphaned += 1
        log.warning("ORPHAN like=%s post=%s (post no longer exists)",
                    like.reference.path, post_ref.id)
        if apply_changes:
            like.reference.delete()
            deleted += 1

    return {"scanned": scanned, "orphaned": orphaned, "deleted": deleted}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true",
                        help="perform writes (default: report only)")
    parser.add_argument("--counts-only", action="store_true",
                        help="reconcile counters but skip the orphan sweep")
    parser.add_argument("--limit", type=int, default=MAX_POSTS,
                        help=f"maximum posts to examine (default {MAX_POSTS})")
    args = parser.parse_args(argv)

    if args.limit <= 0 or args.limit > MAX_POSTS:
        log.error("--limit must be between 1 and %d", MAX_POSTS)
        return 2

    db = get_db()
    if db is None:
        log.error("No Firebase credentials; cannot reconcile.")
        return 1

    verb = "Applied" if args.apply else "Planned (dry run)"

    counts = reconcile_counts(db, args.apply, args.limit)
    log.info("%s counter reconciliation: checked=%d drifted=%d fixed=%d",
             verb, counts["checked"], counts["drifted"], counts["fixed"])

    orphans = {"scanned": 0, "orphaned": 0, "deleted": 0}
    if not args.counts_only:
        orphans = sweep_orphans(db, args.apply)
        log.info("%s orphan sweep: scanned=%d orphaned=%d deleted=%d",
                 verb, orphans["scanned"], orphans["orphaned"], orphans["deleted"])

    if not args.apply and (counts["drifted"] or orphans["orphaned"]):
        log.info("Re-run with --apply to make these changes.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
