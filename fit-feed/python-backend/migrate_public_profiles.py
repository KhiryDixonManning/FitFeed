#!/usr/bin/env python
"""Backfill publicProfiles/{uid} from existing users/{uid} documents.

Profile data was split so that reading someone's display name no longer
exposes their email address:

    users/{uid}           private - email and account fields, owner-only read
    publicProfiles/{uid}  public  - username, displayName, photoURL

This script creates the public half for accounts that predate the split.

Safety properties:
  * Dry run by default. Pass --apply to write.
  * Merge writes only - never overwrites a public profile that already has
    a value, and never deletes anything.
  * Copies ONLY non-sensitive fields. The email address is never written to
    publicProfiles; the display handle uses the email's local part, which is
    what the UI has always rendered publicly.
  * Idempotent: running it twice changes nothing the second time.

Usage:
    python migrate_public_profiles.py            # dry run, prints a plan
    python migrate_public_profiles.py --apply    # perform the writes
"""

from __future__ import annotations

import argparse
import logging
import sys

from auth import get_db

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("migrate")

# Fields that may exist on the legacy users document and are safe to publish.
PUBLIC_FIELDS = ("username", "displayName", "photoURL", "createdAt")


def handle_from_email(email: str | None) -> str:
    """Local part of an email, matching the frontend's handleFromEmail."""
    if not email or "@" not in email:
        return ""
    return email.split("@", 1)[0][:40]


def build_public_profile(uid: str, user_data: dict) -> dict:
    """Assemble the public document. Never includes email."""
    profile: dict = {"uid": uid}

    username = user_data.get("username")
    if isinstance(username, str) and username.strip():
        profile["username"] = username.strip()

    # Prefer an explicit displayName; otherwise derive a handle from the
    # email local part (never the full address).
    display_name = user_data.get("displayName")
    if not (isinstance(display_name, str) and display_name.strip()):
        display_name = handle_from_email(user_data.get("email"))
    if isinstance(display_name, str) and display_name.strip():
        # Defensive: the rules reject '@' in displayName so an address can
        # never land in the public collection through this field.
        profile["displayName"] = display_name.strip().split("@", 1)[0][:60]

    photo_url = user_data.get("photoURL")
    if isinstance(photo_url, str) and photo_url.strip():
        profile["photoURL"] = photo_url.strip()

    created_at = user_data.get("createdAt")
    if isinstance(created_at, str) and created_at.strip():
        profile["createdAt"] = created_at

    return profile


def migrate(apply_changes: bool) -> int:
    db = get_db()
    if db is None:
        log.error(
            "No Firebase credentials. Set GOOGLE_CREDENTIALS_JSON or place "
            "serviceAccountKey.json next to this script."
        )
        return 1

    users = list(db.collection("users").stream())
    log.info("Found %d user documents", len(users))

    created = updated = unchanged = 0

    for user_doc in users:
        uid = user_doc.id
        user_data = user_doc.to_dict() or {}
        desired = build_public_profile(uid, user_data)

        public_ref = db.collection("publicProfiles").document(uid)
        existing_snap = public_ref.get()
        existing = existing_snap.to_dict() or {} if existing_snap.exists else None

        if existing is None:
            created += 1
            log.info("CREATE publicProfiles/%s -> %s", uid, sorted(desired.keys()))
            if apply_changes:
                public_ref.set(desired, merge=True)
            continue

        # Only fill in fields the public document is missing; never clobber
        # a value the user has already set.
        missing = {k: v for k, v in desired.items() if k not in existing or not existing.get(k)}
        if not missing:
            unchanged += 1
            continue

        updated += 1
        log.info("UPDATE publicProfiles/%s -> adds %s", uid, sorted(missing.keys()))
        if apply_changes:
            public_ref.set(missing, merge=True)

    verb = "Applied" if apply_changes else "Planned (dry run)"
    log.info("%s: %d created, %d updated, %d already current", verb, created, updated, unchanged)
    if not apply_changes:
        log.info("Re-run with --apply to perform these writes.")
    log.info("No users documents were modified or deleted.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="perform writes (default: dry run)")
    args = parser.parse_args()
    return migrate(args.apply)


if __name__ == "__main__":
    sys.exit(main())
