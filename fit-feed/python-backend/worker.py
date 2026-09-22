#!/usr/bin/env python
"""Background analysis worker.

Runs as its own Railway process, independent of the web dyno, so closing the
browser cannot cancel analysis. Poll -> lease -> process -> acknowledge.

All security-critical work is reused, not reimplemented: the trusted-host
image fetch (image_fetch), the model call and schema validation
(outfit_analyzer), and the post-level claim that bounds spend
(analysis_jobs). This module only adds scheduling and durability.

Run:
    python worker.py              # poll forever
    python worker.py --once       # single pass, for tests and cron
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv

from analysis_jobs import (
    ClaimOutcome,
    claim_post_for_analysis,
    finalize_failure,
    finalize_success,
)
from auth import get_db
from image_fetch import ImageFetchError, fetch_image_bytes
from job_queue import (
    MAX_JOB_ATTEMPTS,
    LeaseOutcome,
    cancel_job,
    complete_job,
    fail_job,
    fetch_due_jobs,
    lease_job,
    retry_job,
)
from outfit_analyzer import analyze_image_bytes

load_dotenv()

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("fitfeed.worker")

POLL_INTERVAL_SECONDS = int(os.environ.get("WORKER_POLL_SECONDS", "15"))
BATCH_SIZE = int(os.environ.get("WORKER_BATCH_SIZE", "5"))

# Analysis fields the backend owns; mirrors app.ANALYSIS_FIELDS.
ANALYSIS_FIELDS = (
    "palette", "aesthetic", "outfitName", "aestheticTags", "detectedItems",
    "styleDescription", "styleNotes", "aestheticScores",
)

# Failure classification. Permanent failures are data problems that will
# recur identically on every attempt, so retrying only burns budget.
PERMANENT_ERRORS = {
    "post_missing",         # the post was deleted
    "image_invalid",        # not a usable image, wrong host, too large
    "not_owner",            # job uid no longer matches the post author
    "attempts_exhausted",
}
TRANSIENT_ERRORS = {
    "analysis_unavailable",  # model returned nothing usable this time
    "infrastructure",        # Firestore/network wobble
}

_shutdown = False


def _request_shutdown(signum, _frame):
    global _shutdown
    log.info("Signal %s received; finishing the current job then stopping", signum)
    _shutdown = True


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def process_job(db, post_id: str, now: Optional[datetime] = None) -> str:
    """Lease, analyse and acknowledge one job. Returns a short outcome code."""
    moment = now or _utcnow()

    lease = lease_job(db, post_id, now=moment)
    if not lease.leased:
        if lease.outcome is LeaseOutcome.EXHAUSTED:
            fail_job(db, post_id, "attempts_exhausted", now=moment)
            _mirror_failure(db, post_id, moment)
            return "exhausted"
        if lease.outcome is LeaseOutcome.NOT_FOUND:
            return "missing"
        # Another worker owns it, it is already done, or it is not due yet.
        return lease.outcome.value

    job = lease.job or {}
    attempts = job.get("attempts", 1)
    uid = job.get("uid") or ""

    # The post claim is the spend guard: it refuses work that is already
    # complete and bounds per-post attempts independently of the queue.
    claim = claim_post_for_analysis(db, post_id, uid, now=moment)

    if claim.outcome is ClaimOutcome.NOT_FOUND:
        # The post was deleted between enqueue and processing.
        cancel_job(db, post_id, now=moment)
        log.info("Job %s cancelled: post no longer exists", post_id)
        return "cancelled"

    if claim.outcome is ClaimOutcome.ALREADY_COMPLETE:
        complete_job(db, post_id, now=moment)
        return "already_complete"

    if claim.outcome is ClaimOutcome.FORBIDDEN:
        fail_job(db, post_id, "not_owner", now=moment)
        return "not_owner"

    if claim.outcome is ClaimOutcome.TOO_MANY_ATTEMPTS:
        fail_job(db, post_id, "attempts_exhausted", now=moment)
        _mirror_failure(db, post_id, moment)
        return "exhausted"

    if not claim.claimed:
        # Contention or an active claim elsewhere: release and retry later.
        retry_job(db, post_id, "infrastructure", attempts, now=moment)
        return "contended"

    post = claim.post or {}

    try:
        image_bytes = fetch_image_bytes(post.get("imageUrl"))
    except ImageFetchError as exc:
        # A bad or unreachable image will be just as bad next time.
        log.warning("Job %s: image rejected (%s)", post_id, exc)
        finalize_failure(db, post_id, now=moment)
        fail_job(db, post_id, "image_invalid", now=moment)
        return "image_invalid"
    except Exception:
        log.exception("Job %s: image fetch failed unexpectedly", post_id)
        finalize_failure(db, post_id, now=moment)
        _retry_or_fail(db, post_id, "infrastructure", attempts, moment)
        return "infrastructure"

    try:
        result = analyze_image_bytes(image_bytes)
    except Exception:
        log.exception("Job %s: analysis raised", post_id)
        finalize_failure(db, post_id, now=moment)
        _retry_or_fail(db, post_id, "infrastructure", attempts, moment)
        return "infrastructure"

    if not result.get("analyzed"):
        # The model call failed or returned nothing that survived validation.
        # Worth another attempt, within the retry budget.
        finalize_failure(db, post_id, now=moment)
        _retry_or_fail(db, post_id, "analysis_unavailable", attempts, moment)
        return "analysis_unavailable"

    finalize_success(db, post_id, {f: result.get(f) for f in ANALYSIS_FIELDS}, now=moment)
    complete_job(db, post_id, now=moment)
    log.info("Job %s complete", post_id)
    return "complete"


def _retry_or_fail(db, post_id: str, error_code: str, attempts: int, moment: datetime) -> None:
    if attempts >= MAX_JOB_ATTEMPTS:
        log.warning("Job %s failed permanently after %d attempts (%s)",
                    post_id, attempts, error_code)
        fail_job(db, post_id, error_code, now=moment)
    else:
        retry_job(db, post_id, error_code, attempts, now=moment)


def _mirror_failure(db, post_id: str, moment: datetime) -> None:
    """Keep the post's user-visible status in step with a terminal failure."""
    try:
        finalize_failure(db, post_id, now=moment)
    except Exception:
        log.exception("Could not mirror failure onto post %s", post_id)


def run_once(db, limit: int = BATCH_SIZE) -> dict[str, int]:
    """One polling pass. Returns a tally of outcomes."""
    tally: dict[str, int] = {}
    for post_id in fetch_due_jobs(db, limit=limit):
        if _shutdown:
            break
        try:
            outcome = process_job(db, post_id)
        except Exception:
            log.exception("Unhandled error processing job %s", post_id)
            outcome = "error"
        tally[outcome] = tally.get(outcome, 0) + 1
    return tally


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="single pass then exit")
    parser.add_argument("--limit", type=int, default=BATCH_SIZE)
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _request_shutdown)
    signal.signal(signal.SIGTERM, _request_shutdown)

    db = get_db()
    if db is None:
        log.error("No Firebase credentials; the worker cannot run.")
        return 1

    if args.once:
        log.info("Worker pass: %s", run_once(db, args.limit) or "nothing due")
        return 0

    log.info("Worker started (poll=%ss batch=%s)", POLL_INTERVAL_SECONDS, args.limit)
    while not _shutdown:
        tally = run_once(db, args.limit)
        if tally:
            log.info("Worker pass: %s", tally)
        for _ in range(POLL_INTERVAL_SECONDS):
            if _shutdown:
                break
            time.sleep(1)

    log.info("Worker stopped cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
