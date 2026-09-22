"""Durable analysis jobs: enqueue idempotency, leasing, retries, recovery.

Run against the Firestore emulator so lease mutual exclusion is tested with
real transaction semantics. The model is never invoked: the worker's analysis
step is stubbed, and a guard asserts no Anthropic client is ever constructed.
"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

import job_queue
import worker as worker_module
from job_queue import (
    JOBS_COLLECTION,
    MAX_JOB_ATTEMPTS,
    STATUS_COMPLETE,
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_QUEUED,
    LeaseOutcome,
    backoff_delay,
    complete_job,
    enqueue_analysis,
    fetch_due_jobs,
    lease_job,
    retry_job,
)

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
OWNER = "owner_uid"

IMAGE_URL = (
    "https://firebasestorage.googleapis.com/v0/b/fitfeed-67ee8.firebasestorage.app"
    "/o/posts%2Fowner_uid%2F1.jpg?alt=media"
)


@pytest.fixture(scope="module")
def db():
    import os
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture
def post(db):
    post_id = f"job_{uuid.uuid4().hex[:12]}"
    db.collection("posts").document(post_id).set({
        "authorId": OWNER,
        "imageUrl": IMAGE_URL,
        "analysisStatus": "pending",
        "likesCount": 0,
        "commentsCount": 0,
        "createdAt": NOW,
    })
    yield post_id
    db.collection("posts").document(post_id).delete()
    db.collection(JOBS_COLLECTION).document(post_id).delete()


def job_of(db, post_id) -> dict:
    return db.collection(JOBS_COLLECTION).document(post_id).get().to_dict() or {}


class TestEnqueue:
    def test_creates_one_job(self, db, post):
        result = enqueue_analysis(db, post, OWNER, now=NOW)
        assert result["created"] is True
        job = job_of(db, post)
        assert job["status"] == STATUS_QUEUED
        assert job["attempts"] == 0
        assert job["postId"] == post and job["uid"] == OWNER

    def test_duplicate_enqueue_does_not_duplicate_work(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        for _ in range(5):
            result = enqueue_analysis(db, post, OWNER, now=NOW)
            assert result["created"] is False
        # The post id is the job id, so there is exactly one job document.
        jobs = list(db.collection(JOBS_COLLECTION).where(
            filter=gcf.FieldFilter("postId", "==", post)).stream())
        assert len(jobs) == 1

    def test_enqueue_does_not_reset_attempts(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        lease_job(db, post, now=NOW)
        retry_job(db, post, "analysis_unavailable", 1, now=NOW)

        enqueue_analysis(db, post, OWNER, now=NOW)
        # Re-enqueueing makes it due again but the spend budget is preserved.
        assert job_of(db, post)["attempts"] == 1

    def test_a_complete_job_is_not_requeued(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        complete_job(db, post, now=NOW)
        result = enqueue_analysis(db, post, OWNER, now=NOW)
        assert result["status"] == STATUS_COMPLETE
        assert job_of(db, post)["status"] == STATUS_COMPLETE

    def test_an_actively_leased_job_is_left_alone(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        lease_job(db, post, now=NOW)
        result = enqueue_analysis(db, post, OWNER, now=NOW + timedelta(seconds=5))
        assert result["status"] == STATUS_PROCESSING
        assert job_of(db, post)["status"] == STATUS_PROCESSING


class TestLeasing:
    def test_leases_a_due_job(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        result = lease_job(db, post, now=NOW)
        assert result.leased
        job = job_of(db, post)
        assert job["status"] == STATUS_PROCESSING
        assert job["attempts"] == 1
        assert job["leaseExpiresAt"] > NOW

    def test_a_second_lease_is_refused_while_active(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        assert lease_job(db, post, now=NOW).leased
        second = lease_job(db, post, now=NOW + timedelta(seconds=30))
        assert second.outcome is LeaseOutcome.ALREADY_LEASED

    def test_a_job_not_yet_due_is_refused(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        retry_job(db, post, "analysis_unavailable", 1, now=NOW)
        assert lease_job(db, post, now=NOW).outcome is LeaseOutcome.NOT_DUE

    def test_a_missing_job_reports_not_found(self, db):
        assert lease_job(db, "no_such_job", now=NOW).outcome is LeaseOutcome.NOT_FOUND

    def test_a_complete_job_is_never_leased_again(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        complete_job(db, post, now=NOW)
        assert lease_job(db, post, now=NOW).outcome is LeaseOutcome.ALREADY_COMPLETE

    def test_an_expired_lease_is_reclaimed(self, db, post):
        """A worker that crashed mid-job must not wedge it forever."""
        enqueue_analysis(db, post, OWNER, now=NOW)
        assert lease_job(db, post, now=NOW).leased

        later = NOW + timedelta(seconds=job_queue.LEASE_SECONDS + 60)
        recovered = lease_job(db, post, now=later)
        assert recovered.leased
        assert job_of(db, post)["attempts"] == 2

    def test_attempts_are_bounded(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        for i in range(MAX_JOB_ATTEMPTS):
            assert lease_job(db, post, now=NOW).leased, i
            retry_job(db, post, "analysis_unavailable", i + 1, now=NOW)
            db.collection(JOBS_COLLECTION).document(post).update({"availableAt": NOW})
        assert lease_job(db, post, now=NOW).outcome is LeaseOutcome.EXHAUSTED

    def test_two_workers_racing_produce_one_lease(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        barrier = threading.Barrier(6)
        outcomes, errors = [], []
        lock = threading.Lock()

        def attempt():
            barrier.wait()
            try:
                result = lease_job(db, post, now=NOW)
            except BaseException as exc:
                with lock:
                    errors.append(exc)
                return
            with lock:
                outcomes.append(result.outcome)

        threads = [threading.Thread(target=attempt) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"lease raised: {errors!r}"
        assert outcomes.count(LeaseOutcome.LEASED) <= 1, outcomes
        if LeaseOutcome.LEASED in outcomes:
            assert job_of(db, post)["attempts"] == 1


class TestDueQuery:
    def test_finds_queued_and_due(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        assert post in fetch_due_jobs(db, limit=20, now=NOW)

    def test_skips_a_job_scheduled_for_later(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        retry_job(db, post, "analysis_unavailable", 1, now=NOW)
        assert post not in fetch_due_jobs(db, limit=20, now=NOW)

    def test_finds_an_expired_lease(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        lease_job(db, post, now=NOW)
        later = NOW + timedelta(seconds=job_queue.LEASE_SECONDS + 60)
        assert post in fetch_due_jobs(db, limit=20, now=later)

    def test_skips_completed_work(self, db, post):
        enqueue_analysis(db, post, OWNER, now=NOW)
        complete_job(db, post, now=NOW)
        assert post not in fetch_due_jobs(db, limit=20, now=NOW)


class TestBackoff:
    def test_grows_and_is_capped(self):
        delays = [backoff_delay(i) for i in range(1, 12)]
        assert all(0 < d <= job_queue.RETRY_MAX_SECONDS for d in delays)
        assert max(delays[:3]) < job_queue.RETRY_MAX_SECONDS

    def test_is_jittered(self):
        samples = {backoff_delay(3) for _ in range(40)}
        assert len(samples) > 1, "backoff must be jittered, not lockstep"


class TestWorkerProcessing:
    """The worker loop, with the model stubbed out."""

    @pytest.fixture(autouse=True)
    def no_paid_calls(self, monkeypatch):
        def explode(*args, **kwargs):
            raise AssertionError("A test attempted a real Anthropic API call")
        import outfit_analyzer
        monkeypatch.setattr(outfit_analyzer.anthropic, "Anthropic", explode)

    def stub_pipeline(self, monkeypatch, result):
        monkeypatch.setattr(worker_module, "fetch_image_bytes", lambda url: b"fake-bytes")
        monkeypatch.setattr(worker_module, "analyze_image_bytes", lambda data: result)

    def test_a_successful_pass_completes_job_and_post(self, db, post, monkeypatch):
        self.stub_pipeline(monkeypatch, {
            "analyzed": True, "aesthetic": "streetwear", "outfitName": "A Name",
            "palette": [], "aestheticTags": [], "detectedItems": [],
            "styleDescription": None, "styleNotes": None, "aestheticScores": {},
        })
        enqueue_analysis(db, post, OWNER, now=NOW)

        assert worker_module.process_job(db, post) == "complete"
        assert job_of(db, post)["status"] == STATUS_COMPLETE
        stored = db.collection("posts").document(post).get().to_dict()
        assert stored["analysisStatus"] == "complete"
        assert stored["analyzed"] is True
        assert stored["outfitName"] == "A Name"

    def test_a_completed_job_never_calls_the_model_again(self, db, post, monkeypatch):
        calls = []
        monkeypatch.setattr(worker_module, "fetch_image_bytes", lambda url: b"x")
        monkeypatch.setattr(worker_module, "analyze_image_bytes",
                            lambda data: (calls.append(1), {"analyzed": True})[1])
        enqueue_analysis(db, post, OWNER, now=NOW)
        complete_job(db, post, now=NOW)

        assert worker_module.process_job(db, post) == "already_complete"
        assert calls == []

    def test_an_unusable_image_fails_permanently(self, db, post, monkeypatch):
        from image_fetch import ImageFetchError

        def reject(url):
            raise ImageFetchError("not an image")

        monkeypatch.setattr(worker_module, "fetch_image_bytes", reject)
        enqueue_analysis(db, post, OWNER, now=NOW)

        assert worker_module.process_job(db, post) == "image_invalid"
        job = job_of(db, post)
        assert job["status"] == STATUS_FAILED
        assert job["lastErrorCode"] == "image_invalid"
        # And it stays failed: no further attempts are scheduled.
        assert post not in fetch_due_jobs(db, limit=20, now=NOW + timedelta(hours=2))

    def test_a_transient_failure_is_retried_with_backoff(self, db, post, monkeypatch):
        self.stub_pipeline(monkeypatch, {"analyzed": False})
        enqueue_analysis(db, post, OWNER, now=NOW)

        assert worker_module.process_job(db, post) == "analysis_unavailable"
        job = job_of(db, post)
        assert job["status"] == STATUS_QUEUED
        assert job["lastErrorCode"] == "analysis_unavailable"
        assert job["availableAt"] > datetime.now(timezone.utc)

    def test_transient_failures_stop_after_the_attempt_budget(self, db, post, monkeypatch):
        self.stub_pipeline(monkeypatch, {"analyzed": False})
        enqueue_analysis(db, post, OWNER, now=NOW)

        for _ in range(MAX_JOB_ATTEMPTS):
            db.collection(JOBS_COLLECTION).document(post).update(
                {"availableAt": datetime.now(timezone.utc) - timedelta(seconds=1)}
            )
            worker_module.process_job(db, post)

        job = job_of(db, post)
        assert job["status"] == STATUS_FAILED
        assert job["attempts"] <= MAX_JOB_ATTEMPTS

    def test_deleting_the_post_cancels_the_job(self, db, monkeypatch):
        post_id = f"job_{uuid.uuid4().hex[:12]}"
        db.collection("posts").document(post_id).set({
            "authorId": OWNER, "imageUrl": IMAGE_URL,
            "analysisStatus": "pending", "createdAt": NOW,
        })
        enqueue_analysis(db, post_id, OWNER, now=NOW)
        db.collection("posts").document(post_id).delete()

        called = []
        monkeypatch.setattr(worker_module, "fetch_image_bytes",
                            lambda url: called.append(1) or b"x")

        assert worker_module.process_job(db, post_id) == "cancelled"
        assert called == []
        assert not db.collection(JOBS_COLLECTION).document(post_id).get().exists

    def test_a_job_for_a_post_the_uid_no_longer_owns_fails(self, db, post, monkeypatch):
        enqueue_analysis(db, post, "someone_else", now=NOW)
        called = []
        monkeypatch.setattr(worker_module, "fetch_image_bytes",
                            lambda url: called.append(1) or b"x")

        assert worker_module.process_job(db, post) == "not_owner"
        assert called == []
        assert job_of(db, post)["status"] == STATUS_FAILED

    def test_retrying_does_not_duplicate_analysis_writes(self, db, post, monkeypatch):
        self.stub_pipeline(monkeypatch, {
            "analyzed": True, "aesthetic": "vintage", "outfitName": "Once",
            "palette": [], "aestheticTags": [], "detectedItems": [],
            "styleDescription": None, "styleNotes": None, "aestheticScores": {},
        })
        enqueue_analysis(db, post, OWNER, now=NOW)
        assert worker_module.process_job(db, post) == "complete"

        # A second pass must be a no-op, not a second write.
        assert worker_module.process_job(db, post) == "already_complete"
        stored = db.collection("posts").document(post).get().to_dict()
        assert stored["outfitName"] == "Once"
        assert stored["analysisStatus"] == "complete"

    def test_two_workers_racing_invoke_the_model_at_most_once(self, db, post, monkeypatch):
        invocations = []
        lock = threading.Lock()

        def analyse(_data):
            with lock:
                invocations.append(1)
            return {"analyzed": True, "aesthetic": "streetwear", "outfitName": "N",
                    "palette": [], "aestheticTags": [], "detectedItems": [],
                    "styleDescription": None, "styleNotes": None, "aestheticScores": {}}

        monkeypatch.setattr(worker_module, "fetch_image_bytes", lambda url: b"x")
        monkeypatch.setattr(worker_module, "analyze_image_bytes", analyse)
        enqueue_analysis(db, post, OWNER, now=NOW)

        barrier = threading.Barrier(4)
        errors = []

        def run():
            barrier.wait()
            try:
                worker_module.process_job(db, post)
            except BaseException as exc:
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=run) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"worker raised: {errors!r}"
        assert len(invocations) <= 1, f"paid for analysis {len(invocations)} times"

    def test_run_once_processes_due_work(self, db, post, monkeypatch):
        self.stub_pipeline(monkeypatch, {
            "analyzed": True, "aesthetic": "y2k", "outfitName": "Batch",
            "palette": [], "aestheticTags": [], "detectedItems": [],
            "styleDescription": None, "styleNotes": None, "aestheticScores": {},
        })
        enqueue_analysis(db, post, OWNER, now=NOW)
        tally = worker_module.run_once(db, limit=10)
        assert tally.get("complete", 0) >= 1
