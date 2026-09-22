"""Recommendation engine: statistics, time handling, exploration, diversity."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pytest

from recommendation_engine import (
    calculate_score,
    conversation_score,
    diversity_rerank,
    engagement_quality,
    exploration_value,
    freshness_tier,
    get_post_age_hours,
    get_trending,
    rank_posts,
    velocity_score,
    weighted_engagement,
)

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


def post(**kwargs):
    base = {
        "id": kwargs.pop("id", "p1"),
        "likesCount": 0,
        "commentsCount": 0,
        "createdAt": NOW - timedelta(hours=2),
        "category": "streetwear",
    }
    base.update(kwargs)
    return base


class TestEngagementQuality:
    def test_zero_engagement_is_zero(self):
        assert engagement_quality(0, 0) == 0.0

    def test_bounded_between_zero_and_one(self):
        for likes, comments in [(0, 0), (1, 0), (50, 50), (10**6, 10**6)]:
            value = engagement_quality(likes, comments)
            assert 0.0 <= value <= 1.0

    def test_adding_a_comment_never_lowers_quality(self):
        """The old Wilson misuse made an extra comment *reduce* the score."""
        for likes in (0, 1, 5, 50, 500):
            previous = engagement_quality(likes, 0)
            for comments in range(1, 12):
                current = engagement_quality(likes, comments)
                assert current >= previous, (
                    f"comment {comments} lowered quality at {likes} likes: "
                    f"{current} < {previous}"
                )
                previous = current

    def test_adding_a_like_never_lowers_quality(self):
        previous = engagement_quality(0, 3)
        for likes in range(1, 20):
            current = engagement_quality(likes, 3)
            assert current >= previous
            previous = current

    def test_comments_are_worth_more_than_likes(self):
        assert engagement_quality(0, 10) > engagement_quality(10, 0)

    def test_large_counts_saturate(self):
        big = engagement_quality(10_000, 10_000)
        bigger = engagement_quality(1_000_000, 1_000_000)
        assert big <= bigger <= 1.0
        # Saturation means a 100x increase barely moves the needle.
        assert bigger - big < 0.25

    def test_negative_and_malformed_values_are_neutralised(self):
        for likes, comments in [(-5, -5), ("ten", None), (float("nan"), 1),
                                (float("inf"), 0), (True, False), ([], {})]:
            value = engagement_quality(likes, comments)
            assert 0.0 <= value <= 1.0

    def test_saves_contribute_when_supplied(self):
        assert engagement_quality(1, 0, saves=3) > engagement_quality(1, 0)

    def test_impressions_path_is_forward_compatible(self):
        # Same raw engagement, very different exposure: the rate-based branch
        # must reward the post that converted a small audience.
        focused = engagement_quality(10, 0, impressions=20)
        diluted = engagement_quality(10, 0, impressions=100_000)
        assert focused > diluted
        assert 0.0 <= diluted <= focused <= 1.0

    def test_weighted_engagement_ordering(self):
        assert weighted_engagement(0, 0) == 0
        assert weighted_engagement(1, 0) < weighted_engagement(0, 1)


class TestConversationScore:
    def test_no_comments_is_zero(self):
        assert conversation_score(post(likesCount=50, commentsCount=0)) == 0.0

    def test_defined_without_likes(self):
        # The old ratio boost returned 0 whenever likes were 0.
        assert conversation_score(post(likesCount=0, commentsCount=5)) > 0

    def test_bounded(self):
        for likes, comments in [(0, 1000), (1000, 1000), (1, 1)]:
            value = conversation_score(post(likesCount=likes, commentsCount=comments))
            assert 0.0 <= value <= 1.0

    def test_more_comments_never_lowers_it(self):
        previous = 0.0
        for comments in range(1, 15):
            current = conversation_score(post(likesCount=10, commentsCount=comments))
            assert current >= previous
            previous = current


class TestTimeHandling:
    def test_aware_timestamps(self):
        age = get_post_age_hours(NOW - timedelta(hours=5), now=NOW)
        assert age == pytest.approx(5.0, abs=0.01)

    def test_naive_timestamps_are_treated_as_utc(self):
        naive = (NOW - timedelta(hours=3)).replace(tzinfo=None)
        assert get_post_age_hours(naive, now=NOW) == pytest.approx(3.0, abs=0.01)

    def test_iso_strings(self):
        iso = (NOW - timedelta(hours=8)).isoformat()
        assert get_post_age_hours(iso, now=NOW) == pytest.approx(8.0, abs=0.01)

    def test_malformed_timestamps_do_not_raise(self):
        for bad in [None, "", "not-a-date", {}, [], object()]:
            age = get_post_age_hours(bad, now=NOW)
            assert age >= 0.1

    def test_future_timestamps_are_floored(self):
        assert get_post_age_hours(NOW + timedelta(hours=10), now=NOW) == 0.1

    def test_freshness_tiers(self):
        assert freshness_tier(0.5) > freshness_tier(3)
        assert freshness_tier(3) > freshness_tier(12)
        assert freshness_tier(12) > freshness_tier(48)
        assert freshness_tier(48) > freshness_tier(500)


class TestVelocity:
    def test_no_engagement_is_zero(self):
        assert velocity_score(post(), now=NOW) == 0.0

    def test_bounded(self):
        fast = post(likesCount=10_000, commentsCount=10_000,
                    createdAt=NOW - timedelta(minutes=1))
        assert 0.0 <= velocity_score(fast, now=NOW) <= 1.0

    def test_faster_accumulation_scores_higher(self):
        fresh = post(likesCount=20, commentsCount=5, createdAt=NOW - timedelta(hours=1))
        stale = post(likesCount=20, commentsCount=5, createdAt=NOW - timedelta(days=30))
        assert velocity_score(fresh, now=NOW) > velocity_score(stale, now=NOW)


class TestExploration:
    def test_deterministic_for_same_user_post_day(self):
        a = exploration_value("alice", "post1", "2026-06-01")
        b = exploration_value("alice", "post1", "2026-06-01")
        assert a == b

    def test_varies_by_user(self):
        values = {exploration_value(f"user{i}", "post1", "2026-06-01") for i in range(20)}
        assert len(values) > 15

    def test_varies_by_post(self):
        values = {exploration_value("alice", f"post{i}", "2026-06-01") for i in range(20)}
        assert len(values) > 15

    def test_varies_by_day(self):
        a = exploration_value("alice", "post1", "2026-06-01")
        b = exploration_value("alice", "post1", "2026-06-02")
        assert a != b

    def test_bounded(self):
        for i in range(200):
            value = exploration_value(f"u{i}", f"p{i}", "2026-06-01")
            assert 0.0 <= value < 1.0

    def test_stable_across_processes(self):
        """SHA-256, not hash(): Python salts hash() per process."""
        import subprocess
        import sys
        code = (
            "import sys; sys.path.insert(0, '.');"
            "from recommendation_engine import exploration_value;"
            "print(exploration_value('alice','post1','2026-06-01'))"
        )
        runs = {
            subprocess.run([sys.executable, "-c", code], capture_output=True,
                           text=True, cwd=".").stdout.strip()
            for _ in range(2)
        }
        assert len(runs) == 1
        assert runs.pop() == str(exploration_value("alice", "post1", "2026-06-01"))


class TestScoring:
    def test_identical_inputs_give_identical_scores(self):
        p = post(likesCount=5, commentsCount=2)
        first, _ = calculate_score(p, {}, uid="alice", now=NOW, day="2026-06-01")
        second, _ = calculate_score(p, {}, uid="alice", now=NOW, day="2026-06-01")
        assert first == second

    def test_factors_match_the_documented_contract(self):
        _score, factors = calculate_score(post(likesCount=3), {}, uid="alice",
                                          now=NOW, day="2026-06-01")
        assert set(factors["contributions"]) == {
            "engagementQuality", "styleMatch", "trendingVelocity",
            "conversationBoost", "exploration",
        }
        assert "freshnessTier" in factors and "ageHours" in factors

    def test_style_match_is_used_when_supplied(self):
        p = post()
        low, _ = calculate_score(p, {}, uid="a", style_match=0.0, now=NOW, day="d")
        high, _ = calculate_score(p, {}, uid="a", style_match=1.0, now=NOW, day="d")
        assert high > low

    def test_style_match_is_clamped(self):
        p = post()
        insane, factors = calculate_score(p, {}, uid="a", style_match=50.0, now=NOW, day="d")
        capped, _ = calculate_score(p, {}, uid="a", style_match=1.0, now=NOW, day="d")
        assert insane == capped

    def test_personalisation_cannot_dominate_everything(self):
        """A perfectly matched dead post must not outrank a great fresh one."""
        matched_but_stale = post(id="a", likesCount=0, commentsCount=0,
                                 createdAt=NOW - timedelta(days=30))
        unmatched_but_great = post(id="b", likesCount=80, commentsCount=40,
                                   createdAt=NOW - timedelta(minutes=30))
        a, _ = calculate_score(matched_but_stale, {}, uid="u", style_match=1.0, now=NOW, day="d")
        b, _ = calculate_score(unmatched_but_great, {}, uid="u", style_match=0.0, now=NOW, day="d")
        assert b > a

    def test_malformed_posts_do_not_raise(self):
        for bad in [{}, {"likesCount": "x"}, {"createdAt": "bogus"}, {"category": None}]:
            score, factors = calculate_score(bad, {}, uid="u", now=NOW, day="d")
            assert score >= 0
            assert isinstance(factors, dict)


class TestDiversityRerank:
    def make(self, n_per_category):
        scored = []
        for category, count in n_per_category.items():
            for i in range(count):
                p = post(id=f"{category}{i}", category=category)
                # Slight descending relevance within a category.
                scored.append((p, 1.0 - i * 0.01, {"contributions": {}}))
        return sorted(scored, key=lambda row: row[1], reverse=True)

    def test_best_candidate_still_leads(self):
        scored = self.make({"streetwear": 10, "vintage": 5})
        top = diversity_rerank(scored, limit=5)
        assert top[0][1] == max(row[1] for row in scored)

    def test_dominant_category_does_not_take_every_slot(self):
        scored = self.make({"streetwear": 20, "vintage": 6, "y2k": 6})
        page = diversity_rerank(scored, limit=10)
        categories = [p["category"] for p, _s, _f in page]
        assert categories.count("streetwear") < 10
        assert len(set(categories)) >= 2

    def test_a_clearly_worse_post_is_not_promoted_for_diversity_alone(self):
        strong = [(post(id=f"s{i}", category="streetwear"), 1.0, {}) for i in range(5)]
        weak = [(post(id="w0", category="cottagecore"), 0.01, {})]
        page = diversity_rerank(strong + weak, limit=3)
        ids = [p["id"] for p, _s, _f in page]
        assert "w0" not in ids

    def test_deterministic(self):
        scored = self.make({"streetwear": 8, "vintage": 8})
        first = [p["id"] for p, _s, _f in diversity_rerank(scored, limit=8)]
        second = [p["id"] for p, _s, _f in diversity_rerank(scored, limit=8)]
        assert first == second

    def test_empty_input(self):
        assert diversity_rerank([], limit=5) == []

    def test_limit_is_respected(self):
        scored = self.make({"streetwear": 30})
        assert len(diversity_rerank(scored, limit=7)) == 7

    def test_penalty_is_surfaced_in_factors(self):
        scored = self.make({"streetwear": 6})
        page = diversity_rerank(scored, limit=4)
        # Everything after the first shares a category, so it is adjusted.
        assert any(f.get("diversityAdjusted") for _p, _s, f in page[1:])


class TestRankPosts:
    def test_attaches_explanations(self):
        ranked = rank_posts([post(id="a"), post(id="b")], {}, uid="u", day="d", now=NOW)
        assert all("_rankingFactors" in p for p in ranked)

    def test_deterministic_ordering(self):
        posts = [post(id=f"p{i}", likesCount=i) for i in range(10)]
        first = [p["id"] for p in rank_posts(posts, {}, uid="u", day="d", now=NOW)]
        second = [p["id"] for p in rank_posts(posts, {}, uid="u", day="d", now=NOW)]
        assert first == second

    def test_skips_non_dict_entries(self):
        ranked = rank_posts([post(id="a"), "garbage", None, 42], {}, uid="u", day="d", now=NOW)
        assert len(ranked) == 1

    def test_style_matcher_failure_falls_back(self):
        def broken(_post):
            raise RuntimeError("matcher exploded")

        ranked = rank_posts([post(id="a")], {}, uid="u", style_matcher=broken, day="d", now=NOW)
        assert len(ranked) == 1

    def test_limit_caps_the_page(self):
        posts = [post(id=f"p{i}") for i in range(50)]
        assert len(rank_posts(posts, {}, uid="u", limit=10, day="d", now=NOW)) == 10

    def test_empty_input(self):
        assert rank_posts([], {}, uid="u") == []


class TestTrending:
    def test_orders_by_velocity(self):
        fast = post(id="fast", likesCount=30, createdAt=NOW - timedelta(hours=1))
        slow = post(id="slow", likesCount=60, createdAt=NOW - timedelta(days=40))
        ordered = get_trending([slow, fast], now=NOW)
        assert ordered[0]["id"] == "fast"

    def test_tolerates_malformed_entries(self):
        assert len(get_trending([post(), "nope", None], now=NOW)) == 1


class TestPerformance:
    """Algorithmic cost, not a production latency claim."""

    def test_ranking_100_candidates_is_cheap_locally(self):
        posts = [post(id=f"p{i}", likesCount=i % 40, commentsCount=i % 7)
                 for i in range(100)]
        started = time.perf_counter()
        ranked = rank_posts(posts, {}, uid="u", limit=20, now=NOW, day="d")
        elapsed = time.perf_counter() - started
        assert len(ranked) == 20
        # Local wall-clock on developer hardware; generous so it cannot flake.
        assert elapsed < 1.0, f"ranking 100 candidates took {elapsed:.3f}s locally"

    def test_diversity_rerank_comparison_count_is_bounded(self):
        """MMR is O(k*n); assert we stay in that regime, not O(n^2) overall."""
        calls = {"n": 0}
        import recommendation_engine as engine

        original = engine._similarity

        def counting(a, b):
            calls["n"] += 1
            return original(a, b)

        engine._similarity = counting
        try:
            scored = [(post(id=f"p{i}"), 1.0 - i * 0.001, {}) for i in range(100)]
            diversity_rerank(scored, limit=20)
        finally:
            engine._similarity = original

        # k selections * n remaining * k already-selected is the upper bound;
        # with k=20, n=100 that is well under 50k comparisons.
        assert calls["n"] < 50_000, calls["n"]
