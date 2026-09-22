# analysis_jobs.py
"""Atomic claiming of posts for AI analysis.

Analysis costs money per invocation, so exactly one caller may run it for a
given post. Claiming happens inside a Firestore transaction that performs a
compare-and-set on analysisStatus, which gives us mutual exclusion even when
several requests (or several Railway instances) race for the same post.

Lifecycle
---------
    pending ──claim──> processing ──> complete
                           │
                           └────────> failed ──retry──> processing ...

Policies
--------
* Stale claims: a `processing` post whose analysisStartedAt is older than
  STALE_PROCESSING_SECONDS may be reclaimed. Gunicorn kills a request at 120s
  (see Procfile), so anything still marked processing after 5 minutes belongs
  to a worker that died; without this a crash would wedge the post forever.
* Bounded retries: each claim increments analysisAttempts. Once it reaches
  MAX_ANALYSIS_ATTEMPTS the post stops being claimable, so a permanently
  broken image cannot become an unbounded spend loop. The admin
  /reanalyze-all path resets the counter, which is the documented escape
  hatch.

All of these fields are written only through the Admin SDK; firestore.rules
permits no client write to them.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Optional

import grpc
from google.api_core import exceptions as gcp_exceptions
from google.cloud import firestore as gcf

log = logging.getLogger(__name__)

STALE_PROCESSING_SECONDS = 300      # 5 minutes; Gunicorn's request cap is 120s
MAX_ANALYSIS_ATTEMPTS = 3

# Contention retries. Firestore can abort a transaction outright when several
# callers race for one document; retrying the *transaction* (never the model
# call) turns that into a decisive win-or-lose instead of everyone backing off
# and leaving the post pending. Bounded and jittered so latency stays capped:
# worst case here is 2 extra attempts plus <0.3s of sleep.
CLAIM_TRANSACTION_ATTEMPTS = 3
CLAIM_RETRY_BASE_DELAY_S = 0.05
CLAIM_RETRY_MAX_DELAY_S = 0.15


class ClaimOutcome(str, Enum):
    CLAIMED = "claimed"
    ALREADY_COMPLETE = "already_complete"
    ALREADY_PROCESSING = "already_processing"
    TOO_MANY_ATTEMPTS = "too_many_attempts"
    NOT_FOUND = "not_found"
    FORBIDDEN = "forbidden"
    # Firestore aborted the transaction because another writer was competing
    # for the same document. Nothing was committed, so no claim was granted -
    # treated exactly like "someone else is already on it".
    CONTENDED = "contended"


@dataclass
class ClaimResult:
    outcome: ClaimOutcome
    post: Optional[dict[str, Any]] = None
    attempts: int = 0

    @property
    def claimed(self) -> bool:
        return self.outcome is ClaimOutcome.CLAIMED


def _as_utc(value: Any) -> Optional[datetime]:
    """Firestore timestamps come back tz-aware; tolerate naive values too."""
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_contention(exc: BaseException) -> bool:
    """True when an exception means "another writer won", not "broken".

    Firestore surfaces contention in three shapes:
      * google.api_core.exceptions.Aborted
      * a raw grpc error with status ABORTED
      * ValueError("Failed to commit transaction in N attempts.") - the
        client library wraps the final Aborted in a ValueError once its own
        internal retries are exhausted, chaining the cause. Missing this case
        would turn ordinary contention into a 500.
    """
    if isinstance(exc, gcp_exceptions.Aborted):
        return True
    if isinstance(exc, grpc.RpcError) and getattr(exc, "code", lambda: None)() is grpc.StatusCode.ABORTED:
        return True
    if isinstance(exc, ValueError):
        cause = exc.__cause__
        if isinstance(cause, gcp_exceptions.Aborted):
            return True
        if "Failed to commit transaction" in str(exc):
            return True
    return False


def _claim_is_stale(started_at: Any, now: datetime, stale_after_s: int) -> bool:
    started = _as_utc(started_at)
    if started is None:
        # A processing post with no start time predates this mechanism or was
        # written oddly; treat it as stale so it cannot wedge forever.
        return True
    return now - started > timedelta(seconds=stale_after_s)


def claim_post_for_analysis(
    db,
    post_id: str,
    uid: str,
    now: Optional[datetime] = None,
    stale_after_s: int = STALE_PROCESSING_SECONDS,
    max_attempts: int = MAX_ANALYSIS_ATTEMPTS,
) -> ClaimResult:
    """Atomically take ownership of a post's analysis.

    Only the returned CLAIMED result authorises calling the model. Every other
    outcome means some other request already owns the work, it is finished, or
    the caller may not do it.
    """
    moment = now or datetime.now(timezone.utc)
    post_ref = db.collection("posts").document(post_id)

    # Only the claim transaction is retried. It is a pure compare-and-set:
    # each attempt re-reads the document, so a retry that follows someone
    # else's successful claim simply observes 'processing' and loses. The
    # model is never invoked here, so no retry can cause a second paid call.
    for attempt in range(1, CLAIM_TRANSACTION_ATTEMPTS + 1):
        transaction = db.transaction()
        try:
            return _claim_in_transaction(
                transaction, post_ref, uid, moment, stale_after_s, max_attempts
            )
        except Exception as exc:
            if not _is_contention(exc):
                raise

        if attempt < CLAIM_TRANSACTION_ATTEMPTS:
            delay = min(
                CLAIM_RETRY_BASE_DELAY_S * (2 ** (attempt - 1)),
                CLAIM_RETRY_MAX_DELAY_S,
            )
            # Jitter so racing callers do not retry in lockstep.
            time.sleep(random.uniform(0, delay))
            continue

        log.warning(
            "Analysis claim for post %s aborted under contention after %d attempts",
            post_id, attempt,
        )
        return ClaimResult(ClaimOutcome.CONTENDED)

    # Unreachable: the loop either returns a result or exhausts and returns.
    return ClaimResult(ClaimOutcome.CONTENDED)


@gcf.transactional
def _claim_in_transaction(
    transaction, post_ref, uid: str, now: datetime, stale_after_s: int, max_attempts: int
) -> ClaimResult:
    snapshot = post_ref.get(transaction=transaction)
    if not snapshot.exists:
        return ClaimResult(ClaimOutcome.NOT_FOUND)

    data = snapshot.to_dict() or {}

    if data.get("authorId") != uid:
        return ClaimResult(ClaimOutcome.FORBIDDEN)

    if data.get("analyzed") is True or data.get("analysisStatus") == "complete":
        return ClaimResult(ClaimOutcome.ALREADY_COMPLETE, post=data)

    status = data.get("analysisStatus")
    if status == "processing" and not _claim_is_stale(
        data.get("analysisStartedAt"), now, stale_after_s
    ):
        return ClaimResult(ClaimOutcome.ALREADY_PROCESSING, post=data)

    attempts = data.get("analysisAttempts") or 0
    if not isinstance(attempts, int) or attempts < 0:
        attempts = 0
    if attempts >= max_attempts:
        return ClaimResult(ClaimOutcome.TOO_MANY_ATTEMPTS, post=data, attempts=attempts)

    # Compare-and-set: a concurrent transaction that got here first has
    # already moved the document, so this write conflicts and the transaction
    # re-runs, observing 'processing' on the second pass.
    transaction.update(
        post_ref,
        {
            "analysisStatus": "processing",
            "analysisStartedAt": now,
            "analysisAttempts": attempts + 1,
        },
    )
    return ClaimResult(ClaimOutcome.CLAIMED, post=data, attempts=attempts + 1)


def finalize_success(db, post_id: str, fields: dict[str, Any], now: Optional[datetime] = None) -> None:
    """Persist a completed analysis and close out the job."""
    moment = now or datetime.now(timezone.utc)
    updates = dict(fields)
    updates.update({
        "analyzed": True,
        "analysisStatus": "complete",
        "analysisCompletedAt": moment,
    })
    db.collection("posts").document(post_id).update(updates)


def finalize_failure(db, post_id: str, now: Optional[datetime] = None) -> None:
    """Release the claim and record that this attempt failed.

    The attempt counter is left as-is, so the post stays retryable until
    MAX_ANALYSIS_ATTEMPTS is reached.
    """
    moment = now or datetime.now(timezone.utc)
    db.collection("posts").document(post_id).update({
        "analysisStatus": "failed",
        "analysisCompletedAt": moment,
    })


def reset_attempts(db, post_id: str) -> None:
    """Admin escape hatch: make an exhausted post claimable again."""
    db.collection("posts").document(post_id).update({"analysisAttempts": 0})
