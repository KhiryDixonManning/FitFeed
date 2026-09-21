# job_queue.py
"""Durable analysis jobs, backed by Firestore.

Why Firestore and not a broker: the stack already runs Firestore with the
Admin SDK, transactions give the compare-and-set needed for an at-most-once
lease, and the job volume here is one document per upload. Adding Redis,
Celery or a hosted queue would introduce a paid dependency and a second
datastore to operate for a workload a single collection handles. If throughput
ever outgrows a polling worker, the lease semantics below port unchanged to a
real broker.

    analysisJobs/{postId}          (post id as job id => enqueue is idempotent)

        postId          string
        uid             string   owner, captured at enqueue time
        status          queued | processing | complete | failed
        attempts        int      leases taken so far
        createdAt       timestamp
        availableAt     timestamp  not eligible before this (backoff)
        leaseExpiresAt  timestamp  when an abandoned lease may be reclaimed
        lastErrorCode   string     sanitised classification, never a payload
        updatedAt       timestamp

Mutual exclusion is the lease: a worker moves queued -> processing inside a
transaction, so two workers can never both hold the same job. A crashed worker
leaves an expired lease, which a later pass reclaims.
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

JOBS_COLLECTION = "analysisJobs"

STATUS_QUEUED = "queued"
STATUS_PROCESSING = "processing"
STATUS_COMPLETE = "complete"
STATUS_FAILED = "failed"

# A worker holds a job for this long before another may reclaim it. Analysis
# takes ~10-20s; Gunicorn kills a request at 120s. Ten minutes is comfortably
# beyond any legitimate run while still recovering a crash promptly.
LEASE_SECONDS = 600

MAX_JOB_ATTEMPTS = 3

# Exponential backoff with jitter between attempts.
RETRY_BASE_SECONDS = 30
RETRY_MAX_SECONDS = 900

# Same contention retry policy as the post claim.
LEASE_TRANSACTION_ATTEMPTS = 3
LEASE_RETRY_BASE_DELAY_S = 0.05
LEASE_RETRY_MAX_DELAY_S = 0.15


class LeaseOutcome(str, Enum):
    LEASED = "leased"
    NOT_FOUND = "not_found"
    NOT_DUE = "not_due"
    ALREADY_LEASED = "already_leased"
    ALREADY_COMPLETE = "already_complete"
    EXHAUSTED = "exhausted"
    CONTENDED = "contended"


@dataclass
class LeaseResult:
    outcome: LeaseOutcome
    job: Optional[dict] = None

    @property
    def leased(self) -> bool:
        return self.outcome is LeaseOutcome.LEASED


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return None


def _is_contention(exc: BaseException) -> bool:
    """Contention, not breakage. See analysis_jobs._is_contention."""
    if isinstance(exc, gcp_exceptions.Aborted):
        return True
    if isinstance(exc, grpc.RpcError) and getattr(exc, "code", lambda: None)() is grpc.StatusCode.ABORTED:
        return True
    if isinstance(exc, ValueError):
        if isinstance(exc.__cause__, gcp_exceptions.Aborted):
            return True
        if "Failed to commit transaction" in str(exc):
            return True
    return False


def backoff_delay(attempts: int) -> int:
    """Bounded exponential backoff with jitter, in seconds."""
    capped = min(RETRY_BASE_SECONDS * (2 ** max(attempts - 1, 0)), RETRY_MAX_SECONDS)
    return int(capped * (0.5 + random.random() * 0.5))


# --------------------------------------------------------------------- enqueue

def enqueue_analysis(db, post_id: str, uid: str, now: Optional[datetime] = None) -> dict:
    """Create or revive the job for a post. Idempotent by construction.

    The post id is the job id, so a duplicate enqueue updates one document
    rather than creating a second unit of paid work. A job that is already
    complete stays complete; one being processed is left alone.
    """
    moment = now or _utcnow()
    job_ref = db.collection(JOBS_COLLECTION).document(post_id)

    @gcf.transactional
    def _txn(transaction):
        snapshot = job_ref.get(transaction=transaction)
        if snapshot.exists:
            data = snapshot.to_dict() or {}
            status = data.get("status")
            if status == STATUS_COMPLETE:
                return {"status": STATUS_COMPLETE, "created": False}
            if status == STATUS_PROCESSING:
                lease_expiry = _as_aware(data.get("leaseExpiresAt"))
                if lease_expiry and lease_expiry > moment:
                    return {"status": STATUS_PROCESSING, "created": False}
            # Queued, failed or an abandoned lease: make it due now without
            # resetting attempts, so retry budgets survive re-enqueue.
            transaction.update(job_ref, {
                "status": STATUS_QUEUED,
                "availableAt": moment,
                "updatedAt": moment,
            })
            return {"status": STATUS_QUEUED, "created": False}

        transaction.set(job_ref, {
            "postId": post_id,
            "uid": uid,
            "status": STATUS_QUEUED,
            "attempts": 0,
            "createdAt": moment,
            "availableAt": moment,
            "leaseExpiresAt": None,
            "lastErrorCode": None,
            "updatedAt": moment,
        })
        return {"status": STATUS_QUEUED, "created": True}

    try:
        return _txn(db.transaction())
    except Exception as exc:
        if _is_contention(exc):
            log.warning("Enqueue for post %s contended", post_id)
            return {"status": STATUS_QUEUED, "created": False, "contended": True}
        raise


# ----------------------------------------------------------------- claim work

def fetch_due_jobs(db, limit: int = 10, now: Optional[datetime] = None) -> list[str]:
    """Job ids eligible to run: queued and due, or a lease that has expired."""
    moment = now or _utcnow()
    due: list[str] = []

    try:
        queued = (
            db.collection(JOBS_COLLECTION)
            .where(filter=gcf.FieldFilter("status", "==", STATUS_QUEUED))
            .where(filter=gcf.FieldFilter("availableAt", "<=", moment))
            .order_by("availableAt")
            .limit(limit)
            .stream()
        )
        due.extend(doc.id for doc in queued)
    except Exception:
        log.exception("Could not query queued jobs")

    if len(due) < limit:
        try:
            stalled = (
                db.collection(JOBS_COLLECTION)
                .where(filter=gcf.FieldFilter("status", "==", STATUS_PROCESSING))
                .where(filter=gcf.FieldFilter("leaseExpiresAt", "<=", moment))
                .order_by("leaseExpiresAt")
                .limit(limit - len(due))
                .stream()
            )
            due.extend(doc.id for doc in stalled if doc.id not in due)
        except Exception:
            log.exception("Could not query expired leases")

    return due


def lease_job(db, post_id: str, now: Optional[datetime] = None,
              lease_seconds: int = LEASE_SECONDS,
              max_attempts: int = MAX_JOB_ATTEMPTS) -> LeaseResult:
    """Atomically take ownership of a job.

    Only a LEASED result authorises calling the model. Retried on contention
    exactly like the post claim - the transaction is a pure compare-and-set,
    so a retry that follows another worker's win simply observes the lease.
    """
    moment = now or _utcnow()
    job_ref = db.collection(JOBS_COLLECTION).document(post_id)

    @gcf.transactional
    def _txn(transaction) -> LeaseResult:
        snapshot = job_ref.get(transaction=transaction)
        if not snapshot.exists:
            return LeaseResult(LeaseOutcome.NOT_FOUND)

        data = snapshot.to_dict() or {}
        status = data.get("status")

        if status == STATUS_COMPLETE:
            return LeaseResult(LeaseOutcome.ALREADY_COMPLETE, job=data)

        if status == STATUS_PROCESSING:
            lease_expiry = _as_aware(data.get("leaseExpiresAt"))
            if lease_expiry and lease_expiry > moment:
                return LeaseResult(LeaseOutcome.ALREADY_LEASED, job=data)
            # Otherwise the lease has expired and may be reclaimed.

        available_at = _as_aware(data.get("availableAt"))
        if status == STATUS_QUEUED and available_at and available_at > moment:
            return LeaseResult(LeaseOutcome.NOT_DUE, job=data)

        attempts = data.get("attempts") or 0
        if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 0:
            attempts = 0
        if attempts >= max_attempts:
            return LeaseResult(LeaseOutcome.EXHAUSTED, job=data)

        transaction.update(job_ref, {
            "status": STATUS_PROCESSING,
            "attempts": attempts + 1,
            "leaseExpiresAt": moment + timedelta(seconds=lease_seconds),
            "updatedAt": moment,
        })
        return LeaseResult(LeaseOutcome.LEASED, job={**data, "attempts": attempts + 1})

    for attempt in range(1, LEASE_TRANSACTION_ATTEMPTS + 1):
        try:
            return _txn(db.transaction())
        except Exception as exc:
            if not _is_contention(exc):
                raise
        if attempt < LEASE_TRANSACTION_ATTEMPTS:
            delay = min(LEASE_RETRY_BASE_DELAY_S * (2 ** (attempt - 1)), LEASE_RETRY_MAX_DELAY_S)
            time.sleep(random.uniform(0, delay))
            continue
        log.warning("Lease for job %s contended after %d attempts", post_id, attempt)
        return LeaseResult(LeaseOutcome.CONTENDED)

    return LeaseResult(LeaseOutcome.CONTENDED)


# ------------------------------------------------------------ acknowledgement

def complete_job(db, post_id: str, now: Optional[datetime] = None) -> None:
    moment = now or _utcnow()
    db.collection(JOBS_COLLECTION).document(post_id).update({
        "status": STATUS_COMPLETE,
        "leaseExpiresAt": None,
        "lastErrorCode": None,
        "updatedAt": moment,
    })


def retry_job(db, post_id: str, error_code: str, attempts: int,
              now: Optional[datetime] = None) -> None:
    """Release the lease and schedule another attempt after backoff."""
    moment = now or _utcnow()
    delay = backoff_delay(attempts)
    db.collection(JOBS_COLLECTION).document(post_id).update({
        "status": STATUS_QUEUED,
        "availableAt": moment + timedelta(seconds=delay),
        "leaseExpiresAt": None,
        "lastErrorCode": error_code,
        "updatedAt": moment,
    })


def fail_job(db, post_id: str, error_code: str, now: Optional[datetime] = None) -> None:
    """Terminal failure: no further attempts without operator action."""
    moment = now or _utcnow()
    db.collection(JOBS_COLLECTION).document(post_id).update({
        "status": STATUS_FAILED,
        "leaseExpiresAt": None,
        "lastErrorCode": error_code,
        "updatedAt": moment,
    })


def cancel_job(db, post_id: str, now: Optional[datetime] = None) -> None:
    """Remove a job whose post no longer exists."""
    try:
        db.collection(JOBS_COLLECTION).document(post_id).delete()
    except Exception:
        log.exception("Could not cancel job for post %s", post_id)
