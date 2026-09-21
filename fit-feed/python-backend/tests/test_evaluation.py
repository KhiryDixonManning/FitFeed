"""The evaluation harness is itself under test.

A harness that silently stops measuring is worse than no harness, so these
assert the properties it is supposed to detect - and, just as importantly,
that it keeps describing itself honestly.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from evaluate_recommendations import DISCLAIMER, METRICS, build_corpus, run

BACKEND = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def results():
    return run()


class TestHonesty:
    def test_it_refuses_to_claim_accuracy(self):
        lowered = DISCLAIMER.lower()
        assert "not recommendation accuracy" in lowered
        assert "no labelled relevance dataset" in lowered

    def test_no_metric_is_named_like_an_accuracy_metric(self, results):
        # Guard against someone adding precision@k over synthetic fixtures.
        forbidden = ("precision", "recall", "ndcg", "accuracy", "f1", "auc")
        blob = json.dumps(results["metrics"]).lower()
        for word in forbidden:
            assert f'"{word}' not in blob, f"{word} implies ground truth we do not have"

    def test_the_fixture_is_declared_synthetic(self, results):
        assert results["fixture"]["synthetic"] is True


class TestFixture:
    def test_the_corpus_is_deterministic(self):
        assert build_corpus() == build_corpus()

    def test_the_corpus_spans_every_category(self, results):
        assert len(results["fixture"]["categories"]) == 5
        assert results["fixture"]["posts"] == 40


class TestMeasuredProperties:
    def test_every_metric_produced_a_result(self, results):
        assert set(results["metrics"]) == set(METRICS)

    def test_ranking_is_deterministic(self, results):
        determinism = results["metrics"]["determinism"]
        assert determinism["identical_across_runs"] is True
        assert determinism["differs_for_a_different_uid"] is True

    def test_personalisation_actually_changes_the_feed(self, results):
        sensitivity = results["metrics"]["personalisation_sensitivity"]
        # If two different taste profiles produced the same top 10, the
        # personalisation layer would be decorative.
        assert sensitivity["mean_overlap_between_different_profiles"] < 1.0
        assert sensitivity["mean_share_of_top_k_on_profile"] > 0.2

    def test_the_feed_can_reach_the_whole_corpus(self, results):
        assert results["metrics"]["category_coverage"]["coverage"] == 1.0

    def test_mmr_improves_or_holds_early_variety(self, results):
        diversity = results["metrics"]["diversity_at_k"]
        assert (diversity["distinct_categories_after_mmr"]
                >= diversity["distinct_categories_pure_relevance"])
        # The first three slots are where variety is actually felt.
        assert len(set(diversity["categories_after_mmr"][:3])) >= \
            len(set(diversity["categories_pure_relevance"][:3]))

    def test_the_diversity_trade_is_bounded_and_reported(self, results):
        trade = results["metrics"]["relevance_diversity_tradeoff"]
        assert trade["first_slot_is_the_top_ranked_post"] is True
        # Diversity costs something, but not much, and never everything.
        assert 0.8 <= trade["position_discounted_retained"] <= 1.0
        assert trade["relevance_retained"] <= 1.0

    def test_cold_start_is_a_full_feed_not_an_empty_one(self, results):
        cold = results["metrics"]["cold_start"]
        assert cold["returned_everything"] is True
        assert cold["distinct_categories_in_top_k"] > 1
        assert cold["all_scores_finite_and_bounded"] is True

    def test_negative_feedback_removes_what_was_hidden(self, results):
        negative = results["metrics"]["negative_feedback_effect"]
        assert negative["share_of_top_k_before_hiding"] > 0
        assert negative["hidden_posts_fully_excluded"] is True
        assert negative["feed_still_full"] is True


class TestCommandLine:
    def test_it_runs_and_emits_valid_json(self, tmp_path):
        out = tmp_path / "evaluation.json"
        completed = subprocess.run(
            [sys.executable, "evaluate_recommendations.py", "--json", "--out", str(out)],
            cwd=BACKEND, capture_output=True, text=True, timeout=180,
        )
        assert completed.returncode == 0, completed.stderr
        payload = json.loads(completed.stdout)
        assert set(payload["metrics"]) == set(METRICS)
        assert json.loads(out.read_text(encoding="utf8")) == payload

    def test_it_needs_no_network_credentials_or_model(self):
        # Nothing in the harness touches Firestore or Anthropic; it is pure
        # computation over fixtures, which is what makes it CI-safe.
        source = (BACKEND / "evaluate_recommendations.py").read_text(encoding="utf8")
        for forbidden in ("anthropic", "firebase", "firestore", "requests"):
            assert forbidden not in source.lower()
