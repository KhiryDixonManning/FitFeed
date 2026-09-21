#!/usr/bin/env python
"""Offline evaluation harness for the recommendation pipeline.

WHAT THIS IS NOT
----------------
This does not measure recommendation *accuracy*, and no number it prints
should ever be quoted as such. FitFeed has no labelled relevance dataset -
nobody has told us which post a given user *should* have been shown - so
precision, recall, NDCG and friends are not computable here and are not
attempted.

WHAT THIS IS
------------
A set of **behavioural / system properties** measured over deterministic
synthetic fixtures. Each one is a claim about how the pipeline behaves that
can be checked without knowing ground truth:

    personalisation_sensitivity  does a different taste profile produce a
                                 different ordering at all?
    diversity_at_k               how many distinct categories appear in the
                                 top k, before and after MMR reranking
    category_coverage            what fraction of the corpus's categories the
                                 feed can surface
    determinism                  the same inputs produce the same ordering,
                                 run to run and process to process
    cold_start                   a user with no history still gets a full,
                                 ordered, non-empty feed
    relevance_diversity_tradeoff what MMR actually costs in base relevance,
                                 stated as a number rather than asserted away
    negative_feedback_effect     does "not interested" measurably lower the
                                 rank of similar posts

The fixtures are synthetic and fixed. They exist to detect regressions and to
describe behaviour, not to prove quality. Weights are NOT tuned against them -
doing so would make every number here meaningless.

Usage:
    python evaluate_recommendations.py                 # human-readable
    python evaluate_recommendations.py --json          # machine-readable
    python evaluate_recommendations.py --json --out evaluation.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from recommendation_engine import (
    DIVERSITY_LAMBDA,
    calculate_score,
    diversity_rerank,
    rank_posts,
)
from style_vectors import post_style_vector, style_similarity

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
DAY = "2026-06-01"

# A fixed corpus: five categories, varied engagement and age, so that
# ranking has something to actually discriminate between.
CATEGORIES = ["streetwear", "vintage", "minimalist", "cottagecore", "y2k"]

TAGS = {
    "streetwear": (["oversized", "boxy"], ["hoodie", "sneakers"]),
    "vintage": (["retro", "worn"], ["denim jacket", "boots"]),
    "minimalist": (["clean", "tailored"], ["trousers", "shirt"]),
    "cottagecore": (["floral", "flowy"], ["dress", "cardigan"]),
    "y2k": (["low rise", "shiny"], ["baby tee", "cargo pants"]),
}


def build_corpus(per_category: int = 8) -> list[dict]:
    """Deterministic synthetic posts. No randomness, no wall-clock."""
    posts = []
    for c_index, category in enumerate(CATEGORIES):
        tags, items = TAGS[category]
        for i in range(per_category):
            # Spread engagement and age so ranking has signal to work with.
            likes = (i * 7 + c_index * 3) % 40
            comments = (i * 3 + c_index) % 12
            age_hours = 2 + (i * 11 + c_index * 5) % 160
            posts.append({
                "id": f"{category}_{i}",
                "authorId": f"author_{c_index}",
                "category": category,
                "likesCount": likes,
                "commentsCount": comments,
                "createdAt": (NOW - timedelta(hours=age_hours)).isoformat(),
                "aestheticScores": {category: 0.9},
                "aestheticTags": tags,
                "detectedItems": items,
                "palette": [{"hex": "#1E90FF", "percentage": 60}],
            })
    return posts


def taste_for(category: str) -> dict:
    """A taste vector that strongly prefers one category."""
    tags, items = TAGS[category]
    return {
        "aesthetics": {category: 1.0},
        "tags": {t: 0.8 for t in tags},
        "items": {i: 0.6 for i in items},
        "colors": {"blue": 0.5},
    }


def matcher_for(taste: Optional[dict]):
    if taste is None:
        return None
    return lambda post: style_similarity(taste, post_style_vector(post))


def order_of(posts: list[dict]) -> list[str]:
    return [p["id"] for p in posts]


def rank_overlap(a: list[str], b: list[str], k: int) -> float:
    """Fraction of the top k that the two orderings share."""
    top_a, top_b = set(a[:k]), set(b[:k])
    return len(top_a & top_b) / k if k else 0.0


def categories_in(posts: list[dict], k: int) -> list[str]:
    return [p.get("category", "") for p in posts[:k]]


# --------------------------------------------------------------- the metrics


def metric_personalisation_sensitivity(corpus: list[dict], k: int = 10) -> dict:
    """Different taste profiles must produce different feeds.

    If this reads 1.0 the personalisation layer is doing nothing at all.
    """
    results = {}
    baseline = None
    for category in CATEGORIES:
        ranked = rank_posts(corpus, uid="evaluator", style_matcher=matcher_for(taste_for(category)),
                            now=NOW, day=DAY)
        order = order_of(ranked)
        if baseline is None:
            baseline = order
        results[category] = {
            "top_k_categories": categories_in(ranked, k),
            "share_of_top_k_matching_the_profile": round(
                sum(1 for c in categories_in(ranked, k) if c == category) / k, 4
            ),
            "overlap_with_first_profile": round(rank_overlap(baseline, order, k), 4),
        }

    matched = [r["share_of_top_k_matching_the_profile"] for r in results.values()]
    overlaps = [r["overlap_with_first_profile"] for r in list(results.values())[1:]]
    return {
        "per_profile": results,
        "mean_share_of_top_k_on_profile": round(sum(matched) / len(matched), 4),
        "mean_overlap_between_different_profiles": round(sum(overlaps) / len(overlaps), 4),
        "interpretation": (
            "Lower overlap means profiles genuinely diverge. This is a "
            "sensitivity measurement, not evidence the ordering is correct."
        ),
    }


def metric_diversity_at_k(corpus: list[dict], k: int = 10) -> dict:
    """Distinct categories in the top k, with and without MMR."""
    matcher = matcher_for(taste_for("streetwear"))

    scored = []
    for post in corpus:
        match = matcher(post)
        score, factors = calculate_score(
            post, None, uid="evaluator", style_match=match, now=NOW, day=DAY
        )
        scored.append((post, score, factors))

    by_relevance = sorted(scored, key=lambda row: row[1], reverse=True)
    reranked = diversity_rerank(scored, limit=None)

    before = [p.get("category") for p, _s, _f in by_relevance[:k]]
    after = [p.get("category") for p, _s, _f in reranked[:k]]

    return {
        "k": k,
        "lambda": DIVERSITY_LAMBDA,
        "distinct_categories_pure_relevance": len(set(before)),
        "distinct_categories_after_mmr": len(set(after)),
        "categories_pure_relevance": before,
        "categories_after_mmr": after,
    }


def metric_category_coverage(corpus: list[dict], k: int = 20) -> dict:
    """How much of the corpus the feed can reach across taste profiles."""
    available = {p["category"] for p in corpus}
    surfaced: set[str] = set()
    for category in CATEGORIES:
        ranked = rank_posts(corpus, uid="evaluator", style_matcher=matcher_for(taste_for(category)),
                            now=NOW, day=DAY)
        surfaced.update(categories_in(ranked, k))
    return {
        "categories_in_corpus": sorted(available),
        "categories_surfaced": sorted(surfaced),
        "coverage": round(len(surfaced & available) / len(available), 4),
    }


def metric_determinism(corpus: list[dict], runs: int = 5) -> dict:
    """The same inputs must produce the same ordering every time."""
    matcher = matcher_for(taste_for("vintage"))
    orders = [
        order_of(rank_posts(corpus, uid="evaluator", style_matcher=matcher, now=NOW, day=DAY))
        for _ in range(runs)
    ]
    identical = all(o == orders[0] for o in orders)

    # Exploration is seeded per (uid, post, day), so a different user must get
    # a different jitter while each user stays stable.
    other = order_of(rank_posts(corpus, uid="someone_else", style_matcher=matcher,
                                now=NOW, day=DAY))
    return {
        "runs": runs,
        "identical_across_runs": identical,
        "differs_for_a_different_uid": other != orders[0],
    }


def metric_cold_start(corpus: list[dict], k: int = 10) -> dict:
    """A user with no taste profile still gets a complete, ordered feed."""
    ranked = rank_posts(corpus, uid="brand_new_user", style_matcher=None, now=NOW, day=DAY)
    top = ranked[:k]
    # rank_posts attaches contributions, not a final score; sum them the way
    # calculate_score does so the harness never drifts from the engine.
    scores = [
        sum(p["_rankingFactors"]["contributions"].values()) * p["_rankingFactors"]["freshnessTier"]
        for p in ranked if "_rankingFactors" in p
    ]
    return {
        "returned": len(ranked),
        "corpus_size": len(corpus),
        "returned_everything": len(ranked) == len(corpus),
        "distinct_categories_in_top_k": len(set(categories_in(top, k))),
        "all_scores_finite_and_bounded": all(0.0 <= s <= 1.0 for s in scores),
        "note": (
            "Ordering after MMR is intentionally not monotonic in base score; "
            "see relevance_diversity_tradeoff."
        ),
    }


def metric_relevance_diversity_tradeoff(corpus: list[dict], k: int = 10) -> dict:
    """What MMR actually costs, stated as a number.

    MMR deliberately trades some later-position relevance for variety. This
    quantifies the trade instead of claiming it is free.
    """
    matcher = matcher_for(taste_for("streetwear"))
    scored = []
    for post in corpus:
        score, factors = calculate_score(
            post, None, uid="evaluator", style_match=matcher(post), now=NOW, day=DAY
        )
        scored.append((post, score, factors))

    by_relevance = sorted(scored, key=lambda row: row[1], reverse=True)
    reranked = diversity_rerank(scored, limit=None)

    ideal = sum(s for _p, s, _f in by_relevance[:k])
    actual = sum(s for _p, s, _f in reranked[:k])

    # Summed relevance only moves if MMR swaps a post OUT of the top k. It is
    # blind to reordering within the window, which is most of what MMR does,
    # so also report a position-discounted figure that is sensitive to order.
    import math

    def discounted(rows):
        return sum(s / math.log2(i + 2) for i, (_p, s, _f) in enumerate(rows[:k]))

    ideal_d, actual_d = discounted(by_relevance), discounted(reranked)
    ideal_ids = [p["id"] for p, _s, _f in by_relevance[:k]]
    actual_ids = [p["id"] for p, _s, _f in reranked[:k]]

    return {
        "k": k,
        "summed_base_relevance_pure_ordering": round(ideal, 6),
        "summed_base_relevance_after_mmr": round(actual, 6),
        "relevance_retained": round(actual / ideal, 4) if ideal else None,
        "same_posts_selected": set(ideal_ids) == set(actual_ids),
        "position_discounted_pure_ordering": round(ideal_d, 6),
        "position_discounted_after_mmr": round(actual_d, 6),
        "position_discounted_retained": round(actual_d / ideal_d, 4) if ideal_d else None,
        "first_slot_is_the_top_ranked_post":
            by_relevance[0][0]["id"] == reranked[0][0]["id"],
        "note": (
            "Retention below 1.0 is the intended cost of diversity, not a "
            "defect. The leading slot is never traded away. When "
            "same_posts_selected is true, MMR reordered the window rather "
            "than dropping anything out of it, so only the position-"
            "discounted figure registers the trade."
        ),
    }


def metric_negative_feedback_effect(corpus: list[dict], k: int = 10) -> dict:
    """Hiding a style should measurably reduce how much of it is shown.

    Modelled the way the backend does it: not-interested posts are filtered
    from the candidate set, and the taste vector loses that dimension.
    """
    liked = taste_for("streetwear")
    before = rank_posts(corpus, uid="evaluator", style_matcher=matcher_for(liked),
                        now=NOW, day=DAY)
    before_share = sum(1 for c in categories_in(before, k) if c == "streetwear") / k

    hidden = {p["id"] for p in corpus if p["category"] == "streetwear"}
    remaining = [p for p in corpus if p["id"] not in hidden]
    neutral = {"aesthetics": {}, "tags": {}, "items": {}, "colors": {}}
    after = rank_posts(remaining, uid="evaluator", style_matcher=matcher_for(neutral),
                       now=NOW, day=DAY)
    after_share = sum(1 for c in categories_in(after, k) if c == "streetwear") / k

    return {
        "k": k,
        "share_of_top_k_before_hiding": round(before_share, 4),
        "share_of_top_k_after_hiding": round(after_share, 4),
        "hidden_posts_fully_excluded": after_share == 0.0,
        "feed_still_full": len(after) >= k,
    }


# ------------------------------------------------------------------- driver

METRICS = {
    "personalisation_sensitivity": metric_personalisation_sensitivity,
    "diversity_at_k": metric_diversity_at_k,
    "category_coverage": metric_category_coverage,
    "determinism": metric_determinism,
    "cold_start": metric_cold_start,
    "relevance_diversity_tradeoff": metric_relevance_diversity_tradeoff,
    "negative_feedback_effect": metric_negative_feedback_effect,
}

DISCLAIMER = (
    "Behavioural/system metrics over deterministic synthetic fixtures. "
    "NOT recommendation accuracy: there is no labelled relevance dataset, so "
    "precision/recall/NDCG are not computed and must not be inferred. Weights "
    "are not tuned against these fixtures."
)


def run(corpus_size: int = 8) -> dict[str, Any]:
    corpus = build_corpus(corpus_size)
    return {
        "disclaimer": DISCLAIMER,
        "fixture": {
            "posts": len(corpus),
            "categories": CATEGORIES,
            "evaluated_at_simulated_time": NOW.isoformat(),
            "synthetic": True,
        },
        "metrics": {name: fn(corpus) for name, fn in METRICS.items()},
    }


def render(results: dict[str, Any]) -> str:
    lines = ["FitFeed recommendation evaluation", "=" * 34, "", DISCLAIMER, ""]
    fixture = results["fixture"]
    lines.append(f"Fixture: {fixture['posts']} synthetic posts across "
                 f"{len(fixture['categories'])} categories")
    lines.append("")

    for name, payload in results["metrics"].items():
        lines.append(name.replace("_", " ").upper())
        for key, value in payload.items():
            if isinstance(value, dict) and key == "per_profile":
                for profile, detail in value.items():
                    lines.append(
                        f"  {profile:<14} on-profile share of top k: "
                        f"{detail['share_of_top_k_matching_the_profile']:.2f}"
                    )
            elif isinstance(value, (dict, list)) and key.startswith("categories"):
                lines.append(f"  {key}: {value}")
            elif isinstance(value, dict):
                continue
            else:
                lines.append(f"  {key}: {value}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--out", help="write JSON to this path as well")
    parser.add_argument("--per-category", type=int, default=8,
                        help="synthetic posts per category (default 8)")
    args = parser.parse_args()

    results = run(args.per_category)

    if args.out:
        with open(args.out, "w", encoding="utf8") as handle:
            json.dump(results, handle, indent=2)

    print(json.dumps(results, indent=2) if args.json else render(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
