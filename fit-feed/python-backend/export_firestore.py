#!/usr/bin/env python
"""Read-only Firestore backup, for projects without managed backups.

WHY THIS EXISTS
---------------
The preferred backup is Google's own, but both forms of it have prerequisites
this project may not meet:

  * `gcloud firestore export gs://...` needs the gcloud CLI, a Blaze
    (pay-as-you-go) billing account, a GCS bucket, and the
    datastore.databases.export IAM permission.
  * `firebase firestore:backups:schedules:create` needs Blaze as well, and
    creates a RECURRING schedule rather than the one-shot snapshot a
    migration wants.

The Firebase CLI has no one-shot `firestore:export`. On the Spark (free) tier
neither managed option is available at all, which would otherwise leave a
migration with no backup - the one situation where you must not proceed.

So this reads every collection through the Admin SDK, which needs nothing
beyond the credentials the backend already uses, and writes newline-delimited
JSON plus a manifest. It works on any tier.

WHAT IT IS NOT
--------------
Not a substitute for managed backups in general: no point-in-time recovery,
not transactionally consistent across collections (it reads them in
sequence), and it does not capture Storage objects or Auth accounts. Use
`firebase auth:export` for accounts. For this migration that is acceptable -
the migration only ADDS like documents and adjusts a counter, so the recovery
that matters is the targeted rollback, and this snapshot is the backstop for
the catastrophic case.

It NEVER writes to Firestore.

    python export_firestore.py --out backups/2026-09-22-pre-migration
    python export_firestore.py --verify backups/2026-09-22-pre-migration
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

from auth import get_db

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("export-firestore")

# Top-level collections worth capturing before a migration. posts carries the
# likes subcollection; users carries interactions.
COLLECTIONS = [
    "posts",
    "comments",
    "saves",
    "follows",
    "users",
    "publicProfiles",
    "userPreferences",
    "userTasteState",
    "userTasteVectors",
    "analysisJobs",
]

SUBCOLLECTIONS = {
    "posts": ["likes"],
    "users": ["interactions"],
}

MANIFEST = "manifest.json"


def _jsonable(value: Any) -> Any:
    """Firestore types the JSON encoder does not know about."""
    if isinstance(value, (datetime, date)):
        return {"__type__": "timestamp", "value": value.isoformat()}
    if isinstance(value, bytes):
        return {"__type__": "bytes", "value": value.hex()}
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "latitude") and hasattr(value, "longitude"):
        return {"__type__": "geopoint",
                "latitude": value.latitude, "longitude": value.longitude}
    if hasattr(value, "path") and hasattr(value, "id"):
        return {"__type__": "reference", "path": value.path}
    return value


def _write_lines(path: Path, rows: list[dict]) -> str:
    """Write NDJSON and return its SHA-256."""
    digest = hashlib.sha256()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf8", newline="\n") as handle:
        for row in rows:
            line = json.dumps(row, sort_keys=True, ensure_ascii=False)
            handle.write(line + "\n")
            digest.update((line + "\n").encode("utf8"))
    return digest.hexdigest()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export(out_dir: str) -> int:
    db = get_db()
    if db is None:
        log.error("No Firebase credentials. Set GOOGLE_CREDENTIALS_JSON or "
                  "provide serviceAccountKey.json.")
        return 1

    out = Path(out_dir)
    if out.exists() and any(out.iterdir()):
        log.error("%s already exists and is not empty. Pick a new directory so "
                  "an existing backup is never overwritten.", out)
        return 1

    started = datetime.now(timezone.utc)
    files: dict[str, dict] = {}
    total = 0

    for name in COLLECTIONS:
        rows = []
        for snap in db.collection(name).stream():
            rows.append({"id": snap.id, "data": _jsonable(snap.to_dict() or {})})

            for sub in SUBCOLLECTIONS.get(name, []):
                sub_rows = [
                    {"parent": snap.id, "id": d.id, "data": _jsonable(d.to_dict() or {})}
                    for d in snap.reference.collection(sub).stream()
                ]
                if sub_rows:
                    key = f"{name}__{sub}"
                    files.setdefault(key, {"_rows": []})["_rows"].extend(sub_rows)

        digest = _write_lines(out / f"{name}.ndjson", rows)
        files[name] = {"documents": len(rows), "sha256": digest}
        total += len(rows)
        log.info("exported %-20s %6d documents", name, len(rows))

    # Subcollections accumulated above, written once each.
    for key in [k for k in list(files) if "_rows" in files[k]]:
        rows = files[key].pop("_rows")
        digest = _write_lines(out / f"{key}.ndjson", rows)
        files[key] = {"documents": len(rows), "sha256": digest}
        total += len(rows)
        log.info("exported %-20s %6d documents", key, len(rows))

    manifest = {
        "project": os.environ.get("GCLOUD_PROJECT", "unknown"),
        "startedAt": started.isoformat(),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "totalDocuments": total,
        "files": files,
        "note": "Read-only Admin SDK export. Not point-in-time consistent "
                "across collections. Does not include Storage objects or Auth "
                "accounts (use `firebase auth:export` for accounts).",
    }
    (out / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf8")

    log.info("Backup complete: %d documents in %s", total, out)
    log.info("VERIFY IT NOW:  python export_firestore.py --verify %s", out)
    return 0


def verify(out_dir: str) -> int:
    """Re-read the backup and confirm it is complete and uncorrupted.

    A backup nobody verified is a backup nobody has.
    """
    out = Path(out_dir)
    manifest_path = out / MANIFEST
    if not manifest_path.exists():
        log.error("No manifest at %s - this is not a completed backup.", manifest_path)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    problems = 0

    for name, meta in manifest["files"].items():
        path = out / f"{name}.ndjson"
        if not path.exists():
            log.error("MISSING %s", path)
            problems += 1
            continue

        actual_hash = _hash_file(path)
        if actual_hash != meta["sha256"]:
            log.error("CORRUPT %s: sha256 %s != %s", path, actual_hash, meta["sha256"])
            problems += 1
            continue

        lines = sum(1 for line in path.open(encoding="utf8") if line.strip())
        if lines != meta["documents"]:
            log.error("SHORT %s: %d lines, manifest says %d", path, lines, meta["documents"])
            problems += 1
            continue

        # Every line must parse, or the file is not restorable.
        try:
            with path.open(encoding="utf8") as handle:
                for line in handle:
                    if line.strip():
                        json.loads(line)
        except json.JSONDecodeError as exc:
            log.error("UNPARSEABLE %s: %s", path, exc)
            problems += 1
            continue

        log.info("ok  %-24s %6d documents", name, lines)

    if problems:
        log.error("VERIFY FAILED: %d problem(s). Do NOT migrate against this backup.",
                  problems)
        return 1

    log.info("VERIFY OK: %d documents across %d files, all hashes match.",
             manifest["totalDocuments"], len(manifest["files"]))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--out", help="directory to write the backup into")
    group.add_argument("--verify", metavar="DIR", help="verify an existing backup")
    args = parser.parse_args(argv)

    if args.verify:
        return verify(args.verify)
    return export(args.out)


if __name__ == "__main__":
    sys.exit(main())
