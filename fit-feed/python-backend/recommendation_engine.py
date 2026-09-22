# recommendation_engine.py
"""Candidate scoring, diversity reranking and ranking explanations.

Scoring is a weighted sum of bounded [0,1] signals, multiplied by a freshness
tier, then reranked for diversity. Every signal is documented below with why it
carries the weight it does.

    engagement quality   0.30   is this post actually resonating
    style match          0.25   does it match this user's taste (Phase 6)
    trending velocity    0.20   is engagement arriving quickly right now
    conversation         0.10   comments signal more investment than likes
    exploration          0.15   deterministic per user/post/day variation

Personalisation is capped at 0.25 on purpose: a new or narrow taste profile
must not crowd out fresh, high-quality or exploratory content. Freshness is a
multiplier rather than an addend so a strong old post decays instead of
permanently occupying the feed.
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone
from typing import Any, Optional

from utils import convert_timestamp

# ------------------------------------------------------------------- weights

W_ENGAGEMENT = 0.30
W_STYLE_MATCH = 0.25
W_VELOCITY = 0.20
W_CONVERSATION = 0.10
W_EXPLORATION = 0.15

# Engagement quality: a comment is worth more than a like because it costs
# more effort; a save (when a trusted aggregate exists) more still.
LIKE_WEIGHT = 1.0
COMMENT_WEIGHT = 2.5
SAVE_WEIGHT = 3.0

# Weighted engagement at which quality is treated as saturated. Chosen so a
# post with ~40 likes plus ~25 comments reaches the top of the scale on a
# community of this size.
ENGAGEMENT_SATURATION = 100.0

# Velocity saturation: weighted engagement per hour.
VELOCITY_SATURATION = 5.0

# Diversity reranking
DIVERSITY_LAMBDA = 0.35


def _utcnow() -> datetime:
    """Timezone-aware UTC. datetime.utcnow() is deprecated and naive."""
    return datetime.now(timezone.utc)


def _as_aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _safe_count(value: Any) -> float:
    """Counts from Firestore are trusted but may be absent or malformed."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    if not math.isfinite(float(value)) or value < 0:
        return 0.0
    return float(value)


def get_post_age_hours(created_at: Any, now: Optional[datetime] = None) -> float:
    """Age in hours, floored at 0.1 so brand-new posts do not divide by zero."""
    moment = _as_aware(now) if now else _utcnow()
    try:
        created = _as_aware(convert_timestamp(created_at))
    except Exception:
        created = moment
    age = (moment - created).total_seconds() / 3600
    if not math.isfinite(age):
        return 0.1
    return max(age, 0.1)


# -------------------------------------------------------- engagement quality

def weighted_engagement(likes: Any, comments: Any, saves: Any = 0) -> float:
    return (
        _safe_count(likes) * LIKE_WEIGHT
        + _safe_count(comments) * COMMENT_WEIGHT
        + _safe_count(saves) * SAVE_WEIGHT
    )


def engagement_quality(
    likes: Any,
    comments: Any,
    saves: Any = 0,
    impressions: Optional[Any] = None,
) -> float:
    """Bounded [0,1] confidence that a post is resonating.

    The previous implementation fed likes/(likes+comments) into a Wilson
    interval, which treated a comment as a *failed* like: adding a comment
    could lower a post's score. Comments are not failures, and without
    impressions there is no trial count, so there is no meaningful Wilson
    denominator to use.

    Instead this is a saturating function of weighted engagement volume:
    monotonically non-decreasing in every signal, bounded, and with
    diminishing returns so a runaway post cannot dominate forever.

    `impressions` is accepted now and ignored until the signal actually
    exists. Once it does, this becomes a true rate with a Wilson lower bound
    on engagement/impressions, and callers do not change.
    """
    engagement = weighted_engagement(likes, comments, saves)

    seen = _safe_count(impressions) if impressions is not None else 0.0
    if seen > 0:
        # Forward-compatible path: a real rate with a confidence penalty for
        # small samples (Wilson lower bound at 95%).
        rate = min(engagement / (seen * COMMENT_WEIGHT), 1.0)
        return _wilson_lower_bound(rate, seen)

    if engagement <= 0:
        return 0.0
    return min(math.log1p(engagement) / math.log1p(ENGAGEMENT_SATURATION), 1.0)


def _wilson_lower_bound(rate: float, n: float, z: float = 1.96) -> float:
    """Lower bound of the Wilson interval for a genuine success rate."""
    if n <= 0:
        return 0.0
    rate = min(max(rate, 0.0), 1.0)
    denominator = 1 + z**2 / n
    centre = rate + z**2 / (2 * n)
    margin = z * math.sqrt((rate * (1 - rate) + z**2 / (4 * n)) / n)
    return max((centre - margin) / denominator, 0.0)


def velocity_score(post: dict, now: Optional[datetime] = None) -> float:
    """Bounded [0,1] measure of how fast engagement is arriving."""
    age_hours = get_post_age_hours(post.get("createdAt"), now)
    engagement = weighted_engagement(post.get("likesCount"), post.get("commentsCount"))
    if engagement <= 0:
        return 0.0
    per_hour = engagement / (age_hours ** 0.8)
    return min(math.log1p(per_hour) / math.log1p(VELOCITY_SATURATION), 1.0)


def conversation_score(post: dict) -> float:
    """Bounded [0,1] reward for discussion relative to passive liking.

    Unlike the old ratio boost this is defined when there are no likes, and
    it can never decrease when a comment is added.
    """
    likes = _safe_count(post.get("likesCount"))
    comments = _safe_count(post.get("commentsCount"))
    if comments <= 0:
        return 0.0
    share = comments / (comments + likes) if (comments + likes) > 0 else 0.0
    volume = min(math.log1p(comments) / math.log1p(10), 1.0)
    return min(share * volume, 1.0)


def freshness_tier(age_hours: float) -> float:
    if age_hours < 1:
        return 1.5
    if age_hours < 6:
        return 1.2
    if age_hours < 24:
        return 1.0
    if age_hours < 72:
        return 0.8
    return 0.6


# --------------------------------------------------------------- exploration

def exploration_value(uid: str, post_id: str, day: Optional[str] = None) -> float:
    """Deterministic pseudo-random exploration in [0,1).

    Stable for a given (user, post, day) so a user does not see the feed
    reshuffle on every request, but different across users and across days.
    SHA-256 rather than hash(): Python salts hash() per process, so with
    several Gunicorn workers the same request could otherwise rank differently
    depending on which worker served it.
    """
    stamp = day or _utcnow().strftime("%Y-%m-%d")
    digest = hashlib.sha256(f"{uid}:{post_id}:{stamp}".encode("utf-8")).digest()
    # 8 bytes is ample resolution and keeps the arithmetic small.
    return int.from_bytes(digest[:8], "big") / float(1 << 64)


# ------------------------------------------------------------------- scoring

def calculate_score(
    post: dict,
    user_preferences: Optional[dict] = None,
    uid: str = "",
    style_match: Optional[float] = None,
    now: Optional[datetime] = None,
    day: Optional[str] = None,
) -> tuple[float, dict]:
    """Score one candidate and return (score, explanation factors)."""
    preferences = user_preferences or {}
    post_id = str(post.get("id") or "")
    category = post.get("category") or "general"

    quality = engagement_quality(post.get("likesCount"), post.get("commentsCount"))
    velocity = velocity_score(post, now)
    conversation = conversation_score(post)
    age_hours = get_post_age_hours(post.get("createdAt"), now)
    freshness = freshness_tier(age_hours)
    exploration = exploration_value(uid, post_id, day)

    # Style match comes from the Phase 6 taste vector when available; the
    # category counter is the fallback for users with no vector yet.
    if style_match is None:
        raw_preference = preferences.get(category, 0)
        style = min(_safe_count(raw_preference) / 10.0, 1.0)
    else:
        style = min(max(float(style_match), 0.0), 1.0)

    contributions = {
        "engagementQuality": round(quality * W_ENGAGEMENT, 4),
        "styleMatch": round(style * W_STYLE_MATCH, 4),
        "trendingVelocity": round(velocity * W_VELOCITY, 4),
        "conversationBoost": round(conversation * W_CONVERSATION, 4),
        "exploration": round(exploration * W_EXPLORATION, 4),
    }

    score = sum(contributions.values()) * freshness

    factors = {
        "contributions": contributions,
        "freshnessTier": freshness,
        "ageHours": round(age_hours, 1),
        "matchedCategory": category if style > 0 else None,
        "diversityAdjusted": False,
    }
    return score, factors


# ----------------------------------------------------------------- diversity

def _similarity(post_a: dict, post_b: dict) -> float:
    """Cheap symmetric similarity in [0,1] for reranking.

    Category equality dominates; shared aesthetic and tags refine it. Phase 6
    style vectors can replace this without changing the reranker.
    """
    score = 0.0
    if post_a.get("category") and post_a.get("category") == post_b.get("category"):
        score += 0.6
    if post_a.get("aesthetic") and post_a.get("aesthetic") == post_b.get("aesthetic"):
        score += 0.25

    tags_a = {t for t in (post_a.get("aestheticTags") or []) if isinstance(t, str)}
    tags_b = {t for t in (post_b.get("aestheticTags") or []) if isinstance(t, str)}
    if tags_a and tags_b:
        overlap = len(tags_a & tags_b) / len(tags_a | tags_b)
        score += 0.15 * overlap

    return min(score, 1.0)


def diversity_rerank(
    scored: list[tuple[dict, float, dict]],
    limit: Optional[int] = None,
    lambda_: float = DIVERSITY_LAMBDA,
) -> list[tuple[dict, float, dict]]:
    """Greedy MMR-style selection balancing relevance against redundancy.

    At each step pick the candidate maximising

        relevance - lambda * max_similarity_to_already_selected

    Unlike the previous pre-sort penalty (which punished a category by its
    position in an arbitrary input order), this only ever penalises a post
    relative to what has actually been selected.

    Precisely what this guarantees: the highest base-relevance candidate is
    placed first, unpenalised. Every subsequent slot makes a bounded
    relevance/diversity tradeoff - a slightly weaker but less redundant post
    can outrank a stronger near-duplicate. The penalty is proportional to the
    candidate's own score (at most lambda x score), so a much weaker post
    cannot leapfrog a much stronger one on diversity alone.

    Cost is O(k*n) for k selections over n candidates - with n<=100 and k<=30
    that is a few thousand cheap comparisons.
    """
    if not scored:
        return []

    remaining = sorted(scored, key=lambda row: row[1], reverse=True)
    target = len(remaining) if limit is None else min(limit, len(remaining))

    selected: list[tuple[dict, float, dict]] = []
    # The strongest candidate leads, unpenalised; tradeoffs start at slot two.
    selected.append(remaining.pop(0))

    while remaining and len(selected) < target:
        best_index = 0
        best_value = None
        for index, (post, score, _factors) in enumerate(remaining):
            penalty = max(
                (_similarity(post, chosen[0]) for chosen in selected),
                default=0.0,
            )
            value = score - lambda_ * penalty * score
            if best_value is None or value > best_value:
                best_value = value
                best_index = index

        post, score, factors = remaining.pop(best_index)
        penalty = max((_similarity(post, chosen[0]) for chosen in selected), default=0.0)
        if penalty > 0:
            factors = {**factors, "diversityAdjusted": True,
                       "diversityPenalty": round(lambda_ * penalty, 4)}
        selected.append((post, score, factors))

    return selected


# ------------------------------------------------------------------- ranking

def rank_posts(
    posts: list[dict],
    user_preferences: Optional[dict] = None,
    uid: str = "",
    style_matcher=None,
    limit: Optional[int] = None,
    now: Optional[datetime] = None,
    day: Optional[str] = None,
) -> list[dict]:
    """Score, rerank for diversity and attach explanations.

    `style_matcher` is an optional callable(post) -> float in [0,1]; when
    absent the category-preference fallback is used.
    """
    scored: list[tuple[dict, float, dict]] = []
    for post in posts:
        if not isinstance(post, dict):
            continue
        match = None
        if style_matcher is not None:
            try:
                match = style_matcher(post)
            except Exception:
                log_match_failure(post)
                match = None
        score, factors = calculate_score(
            post, user_preferences, uid=uid, style_match=match, now=now, day=day
        )
        scored.append((post, score, factors))

    reranked = diversity_rerank(scored, limit=limit)
    return [{**post, "_rankingFactors": factors} for post, _score, factors in reranked]


def log_match_failure(post: dict) -> None:
    import logging
    logging.getLogger(__name__).warning(
        "Style matcher failed for post %s; falling back to category preference",
        post.get("id"),
    )


def get_trending(posts: list[dict], now: Optional[datetime] = None) -> list[dict]:
    """Velocity-ordered, so fast risers beat high-but-stale totals."""
    return sorted(
        (p for p in posts if isinstance(p, dict)),
        key=lambda p: velocity_score(p, now),
        reverse=True,
    )
