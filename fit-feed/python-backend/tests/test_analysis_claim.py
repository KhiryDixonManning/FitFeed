"""Atomic analysis-claim tests against the real Firestore emulator.

These use the emulator rather than a mock so the transaction semantics under
test are Firestore's own: two racing transactions, optimistic concurrency and
automatic retry. A hand-written fake could not prove mutual exclusion.

No Anthropic calls happen here - the "AI invocation" is a counter guarded by
the claim, which is exactly the property we care about.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

from analysis_jobs import (
    MAX_ANALYSIS_ATTEMPTS,
    STALE_PROCESSING_SECONDS,
    ClaimOutcome,
    claim_post_for_analysis,
    finalize_failure,
    finalize_success,
    reset_attempts,
)

OWNER = "owner_uid"
STRANGER = "stranger_uid"


@pytest.fixture(scope="module")
def db():
    host = os.environ.get("FIRESTORE_EMULATOR_HOST")
    if not host:
        raise RuntimeError(
            "FIRESTORE_EMULATOR_HOST is not set. Run the backend suite via "
            "`npm run test:backend`, which starts the Firestore emulator."
        )
    # With the emulator host set, the client uses anonymous credentials.
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture
def post(db):
    """A fresh pending post owned by OWNER."""
    post_id = f"post_{uuid.uuid4().hex[:12]}"
    db.collection("posts").document(post_id).set({
        "authorId": OWNER,
        "imageUrl": "https://firebasestorage.googleapis.com/v0/b/b/o/posts%2Fowner_uid%2F1.jpg",
        "analysisStatus": "pending",
        "likesCount": 0,
        "commentsCount": 0,
    })
    yield post_id
    db.collection("posts").document(post_id).delete()


def read(db, post_id) -> dict:
    return db.collection("posts").document(post_id).get().to_dict() or {}


class TestSingleClaim:
    def test_a_pending_post_can_be_claimed(self, db, post):
        result = claim_post_for_analysis(db, post, OWNER)
        assert result.outcome is ClaimOutcome.CLAIMED
        assert result.claimed

        stored = read(db, post)
        assert stored["analysisStatus"] == "processing"
        assert stored["analysisAttempts"] == 1
        assert stored["analysisStartedAt"] is not None

    def test_a_post_being_processed_is_not_claimed_again(self, db, post):
        assert claim_post_for_analysis(db, post, OWNER).claimed
        second = claim_post_for_analysis(db, post, OWNER)
        assert second.outcome is ClaimOutcome.ALREADY_PROCESSING
        assert not second.claimed
        # The first claim's attempt count is untouched by the refusal.
        assert read(db, post)["analysisAttempts"] == 1

    def test_a_completed_post_is_never_claimed(self, db, post):
        assert claim_post_for_analysis(db, post, OWNER).claimed
        finalize_success(db, post, {"aesthetic": "streetwear"})

        again = claim_post_for_analysis(db, post, OWNER)
        assert again.outcome is ClaimOutcome.ALREADY_COMPLETE
        assert not again.claimed

    def test_analyzed_true_alone_blocks_a_claim(self, db, post):
        # Legacy posts predate analysisStatus but carry analyzed: True.
        db.collection("posts").document(post).update({
            "analyzed": True, "analysisStatus": gcf.DELETE_FIELD,
        })
        assert claim_post_for_analysis(db, post, OWNER).outcome is ClaimOutcome.ALREADY_COMPLETE

    def test_a_missing_post_reports_not_found(self, db):
        result = claim_post_for_analysis(db, "does_not_exist", OWNER)
        assert result.outcome is ClaimOutcome.NOT_FOUND

    def test_a_stranger_cannot_claim_someone_elses_post(self, db, post):
        result = claim_post_for_analysis(db, post, STRANGER)
        assert result.outcome is ClaimOutcome.FORBIDDEN
        assert not result.claimed
        # Nothing was written on the rejected path.
        assert read(db, post)["analysisStatus"] == "pending"
        assert "analysisAttempts" not in read(db, post)


class TestRetryPolicy:
    def test_a_failed_post_can_be_retried(self, db, post):
        assert claim_post_for_analysis(db, post, OWNER).claimed
        finalize_failure(db, post)
        assert read(db, post)["analysisStatus"] == "failed"

        retry = claim_post_for_analysis(db, post, OWNER)
        assert retry.claimed
        assert read(db, post)["analysisAttempts"] == 2

    def test_retries_are_bounded(self, db, post):
        for expected in range(1, MAX_ANALYSIS_ATTEMPTS + 1):
            result = claim_post_for_analysis(db, post, OWNER)
            assert result.claimed, f"attempt {expected} should be claimable"
            finalize_failure(db, post)

        exhausted = claim_post_for_analysis(db, post, OWNER)
        assert exhausted.outcome is ClaimOutcome.TOO_MANY_ATTEMPTS
        assert not exhausted.claimed
        assert read(db, post)["analysisAttempts"] == MAX_ANALYSIS_ATTEMPTS

    def test_admin_reset_restores_claimability(self, db, post):
        for _ in range(MAX_ANALYSIS_ATTEMPTS):
            claim_post_for_analysis(db, post, OWNER)
            finalize_failure(db, post)
        assert claim_post_for_analysis(db, post, OWNER).outcome is ClaimOutcome.TOO_MANY_ATTEMPTS

        reset_attempts(db, post)
        assert claim_post_for_analysis(db, post, OWNER).claimed


class TestStaleClaims:
    def test_a_stale_processing_claim_can_be_recovered(self, db, post):
        # Simulate a worker that died mid-analysis.
        stale_start = datetime.now(timezone.utc) - timedelta(seconds=STALE_PROCESSING_SECONDS + 60)
        db.collection("posts").document(post).update({
            "analysisStatus": "processing",
            "analysisStartedAt": stale_start,
            "analysisAttempts": 1,
        })

        recovered = claim_post_for_analysis(db, post, OWNER)
        assert recovered.claimed
        assert read(db, post)["analysisAttempts"] == 2

    def test_a_fresh_processing_claim_is_respected(self, db, post):
        recent = datetime.now(timezone.utc) - timedelta(seconds=5)
        db.collection("posts").document(post).update({
            "analysisStatus": "processing",
            "analysisStartedAt": recent,
            "analysisAttempts": 1,
        })
        assert claim_post_for_analysis(db, post, OWNER).outcome is ClaimOutcome.ALREADY_PROCESSING

    def test_processing_without_a_timestamp_is_treated_as_stale(self, db, post):
        db.collection("posts").document(post).update({
            "analysisStatus": "processing", "analysisAttempts": 1,
        })
        assert claim_post_for_analysis(db, post, OWNER).claimed

    def test_stale_recovery_still_respects_the_attempt_ceiling(self, db, post):
        stale_start = datetime.now(timezone.utc) - timedelta(seconds=STALE_PROCESSING_SECONDS + 60)
        db.collection("posts").document(post).update({
            "analysisStatus": "processing",
            "analysisStartedAt": stale_start,
            "analysisAttempts": MAX_ANALYSIS_ATTEMPTS,
        })
        assert claim_post_for_analysis(db, post, OWNER).outcome is ClaimOutcome.TOO_MANY_ATTEMPTS


class TestConcurrency:
    """The cost-safety property: concurrent callers never both pay.

    Under heavy contention Firestore may abort a transaction outright
    (CONTENDED) rather than resolving it, so the guarantee is "at most one
    winner", never "two winners". Liveness is covered by the retry tests: a
    caller that loses simply asks again.
    """

    @staticmethod
    def _race(db, post_id, workers):
        barrier = threading.Barrier(workers)
        outcomes: list[ClaimOutcome] = []
        errors: list[BaseException] = []
        lock = threading.Lock()

        def attempt():
            barrier.wait()  # maximise contention
            try:
                result = claim_post_for_analysis(db, post_id, OWNER)
            except BaseException as exc:  # noqa: BLE001 - surfaced below
                with lock:
                    errors.append(exc)
                return
            with lock:
                outcomes.append(result.outcome)

        threads = [threading.Thread(target=attempt) for _ in range(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        # A claim must never raise at the caller: contention is an outcome,
        # not an error. Surface escapes loudly rather than as a short list.
        assert not errors, f"claim raised instead of returning an outcome: {errors!r}"
        assert len(outcomes) == workers
        return outcomes

    def test_two_concurrent_claims_never_both_win(self, db, post):
        outcomes = self._race(db, post, 2)
        assert outcomes.count(ClaimOutcome.CLAIMED) <= 1, outcomes
        # No thread crashed: every result is a real outcome.
        assert all(o in set(ClaimOutcome) for o in outcomes)
        if ClaimOutcome.CLAIMED in outcomes:
            assert read(db, post)["analysisAttempts"] == 1

    def test_eight_concurrent_claims_never_produce_two_winners(self, db, post):
        outcomes = self._race(db, post, 8)
        assert outcomes.count(ClaimOutcome.CLAIMED) <= 1, outcomes
        if ClaimOutcome.CLAIMED in outcomes:
            assert read(db, post)["analysisAttempts"] == 1

    def test_concurrent_requests_invoke_the_model_at_most_once(self, db, post):
        """Same race, expressed as the thing that actually costs money."""
        invocations: list[str] = []
        lock = threading.Lock()
        barrier = threading.Barrier(4)

        def request_analysis():
            barrier.wait()
            claim = claim_post_for_analysis(db, post, OWNER)
            if claim.claimed:
                # Stand-in for analyze_image_bytes(); never a real API call.
                with lock:
                    invocations.append("claude")

        threads = [threading.Thread(target=request_analysis) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(invocations) <= 1, f"paid for analysis {len(invocations)} times"

    def test_a_contended_loser_never_gets_a_claim(self, db, post):
        """Whoever loses must not be told to proceed."""
        outcomes = self._race(db, post, 6)
        losers = [o for o in outcomes if o is not ClaimOutcome.CLAIMED]
        assert losers, "expected at least one loser in a 6-way race"
        for outcome in losers:
            assert outcome in (
                ClaimOutcome.ALREADY_PROCESSING,
                ClaimOutcome.CONTENDED,
            ), outcome

    def test_the_post_is_left_in_a_sane_state_after_a_race(self, db, post):
        self._race(db, post, 6)
        stored = read(db, post)
        # Either someone claimed it (processing, one attempt) or everyone
        # aborted and it is untouched - never a half-written state.
        if stored.get("analysisStatus") == "processing":
            assert stored["analysisAttempts"] == 1
        else:
            assert stored.get("analysisStatus") == "pending"
            assert "analysisAttempts" not in stored

    def test_a_loser_can_claim_once_the_winner_finishes_and_fails(self, db, post):
        """Liveness: contention delays work, it does not lose it."""
        self._race(db, post, 4)
        if read(db, post).get("analysisStatus") == "processing":
            finalize_failure(db, post)
        retry = claim_post_for_analysis(db, post, OWNER)
        assert retry.claimed


class TestContentionRetry:
    """Losing one transaction to contention must not lose the work."""

    def test_a_transient_abort_recovers_within_the_same_request(self, db, post, monkeypatch):
        import analysis_jobs
        from google.api_core import exceptions as gcp_exceptions

        real = analysis_jobs._claim_in_transaction
        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise gcp_exceptions.Aborted("Transaction lock timeout.")
            return real(*args, **kwargs)

        monkeypatch.setattr(analysis_jobs, "_claim_in_transaction", flaky)

        # The caller still gets its claim - no unrelated later request needed.
        result = analysis_jobs.claim_post_for_analysis(db, post, OWNER)
        assert result.claimed
        assert calls["n"] == 2
        assert read(db, post)["analysisAttempts"] == 1

    def test_retries_are_bounded_and_then_report_contention(self, db, post, monkeypatch):
        import analysis_jobs
        from google.api_core import exceptions as gcp_exceptions

        calls = {"n": 0}

        def always_aborts(*args, **kwargs):
            calls["n"] += 1
            raise gcp_exceptions.Aborted("Transaction lock timeout.")

        monkeypatch.setattr(analysis_jobs, "_claim_in_transaction", always_aborts)

        result = analysis_jobs.claim_post_for_analysis(db, post, OWNER)
        assert result.outcome is ClaimOutcome.CONTENDED
        assert calls["n"] == analysis_jobs.CLAIM_TRANSACTION_ATTEMPTS
        # Nothing was written, so the post stays claimable later.
        assert read(db, post)["analysisStatus"] == "pending"

    def test_retrying_never_produces_a_second_winner(self, db, post, monkeypatch):
        """A retry that follows someone else's win must lose."""
        import analysis_jobs
        from google.api_core import exceptions as gcp_exceptions

        real = analysis_jobs._claim_in_transaction
        calls = {"n": 0}

        def abort_then_retry(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                # Simulate: our first attempt aborted because a competing
                # claim committed in the meantime.
                analysis_jobs._claim_in_transaction = real
                db.collection("posts").document(post).update({
                    "analysisStatus": "processing",
                    "analysisStartedAt": datetime.now(timezone.utc),
                    "analysisAttempts": 1,
                })
                raise gcp_exceptions.Aborted("Transaction lock timeout.")
            return real(*args, **kwargs)

        monkeypatch.setattr(analysis_jobs, "_claim_in_transaction", abort_then_retry)

        result = analysis_jobs.claim_post_for_analysis(db, post, OWNER)
        assert not result.claimed
        assert result.outcome is ClaimOutcome.ALREADY_PROCESSING
        assert read(db, post)["analysisAttempts"] == 1

    def test_claim_latency_stays_bounded_under_full_contention(self, db, post, monkeypatch):
        import analysis_jobs
        from google.api_core import exceptions as gcp_exceptions

        monkeypatch.setattr(
            analysis_jobs, "_claim_in_transaction",
            lambda *a, **k: (_ for _ in ()).throw(gcp_exceptions.Aborted("lock")),
        )
        started = time.monotonic()
        analysis_jobs.claim_post_for_analysis(db, post, OWNER)
        elapsed = time.monotonic() - started
        # 3 attempts with jittered backoff capped at 0.15s each.
        assert elapsed < 1.0, f"claim took {elapsed:.2f}s"
