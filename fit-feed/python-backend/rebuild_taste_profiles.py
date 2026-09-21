#!/usr/bin/env python
"""Rebuild cached user taste vectors (userTasteVectors/{uid}).

Taste vectors are derived state: they are rebuilt automatically when stale or
when the algorithm version changes. This script forces a rebuild for every
user, which is useful after tuning weights or bumping a version.

Safety properties:
  * Dry run by default; pass --apply to write.
  * Idempotent - rebuilding twice produces the same vector for the same data.
  * Derives only from data that already exists (preferences, likes, saves).
  * Makes NO Anthropic calls and never triggers reanalysis.
  * Never deletes posts, users or preferences.

Usage:
    python rebuild_taste_profiles.py           # dry run
    python rebuild_taste_profiles.py --apply   # write the vectors
"""

from __future__ import annotations

import argparse
import logging
import sys

from auth import get_db
from taste_profile import TASTE_VECTOR_VERSION, build_taste_vector

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("rebuild-taste")


def rebuild(apply_changes: bool, limit: int | None = None) -> int:
    db = get_db()
    if db is None:
        log.error("No Firebase credentials. Set GOOGLE_CREDENTIALS_JSON or "
                  "provide serviceAccountKey.json.")
        return 1

    users = list(db.collection("users").stream())
    if limit:
        users = users[:limit]
    log.info("Rebuilding taste vectors for %d users (version %d)",
             len(users), TASTE_VECTOR_VERSION)

    built = empty = 0
    for user_doc in users:
        uid = user_doc.id
        vector = build_taste_vector(db, uid)
        signals = vector.get("signals", {})
        if vector.get("isEmpty"):
            empty += 1
            log.info("EMPTY  %s (no usable interaction signals yet)", uid)
        else:
            built += 1
            log.info("BUILD  %s aesthetics=%d signals=%s",
                     uid, len(vector.get("aesthetics", {})), signals)
        if apply_changes:
            db.collection("userTasteVectors").document(uid).set(vector)

    verb = "Wrote" if apply_changes else "Planned (dry run)"
    log.info("%s: %d vectors with signal, %d cold-start users", verb, built, empty)
    if not apply_changes:
        log.info("Re-run with --apply to persist them.")
    log.info("No posts, preferences or accounts were modified.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write vectors (default: dry run)")
    parser.add_argument("--limit", type=int, default=None, help="process at most N users")
    args = parser.parse_args()
    return rebuild(args.apply, args.limit)


if __name__ == "__main__":
    sys.exit(main())
