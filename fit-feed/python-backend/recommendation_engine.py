# recommendation_engine.py

from utils import convert_timestamp
from datetime import datetime
import random
import math


def normalize(value, max_value=100):
    if max_value == 0:
        return 0
    return min(value / max_value, 1)


def get_post_age_hours(created_at):
    created_time = convert_timestamp(created_at)
    now = datetime.utcnow()
    return max((now - created_time).total_seconds() / 3600, 0.1)


def wilson_score(likes, total_interactions):
    """
    Statistical confidence interval for engagement rate.
    Same approach Reddit used for years.
    A post with 10 likes out of 10 views scores higher than
    10 likes out of 1000 views.
    """
    if total_interactions == 0:
        return 0
    n = total_interactions
    p = likes / n
    z = 1.96  # 95% confidence interval
    numerator = p + z**2/(2*n) - z * math.sqrt((p*(1-p) + z**2/(4*n))/n)
    denominator = 1 + z**2/n
    return max(numerator / denominator, 0)


def velocity_score(post):
    """
    Measures engagement rate per hour since posting.
    Trending posts with fast engagement rise quickly.
    """
    age_hours = get_post_age_hours(post.get("createdAt"))
    likes = post.get("likesCount", 0)
    comments = post.get("commentsCount", 0)
    engagement = (likes * 0.4) + (comments * 0.6)
    return engagement / (age_hours ** 0.8)


def engagement_ratio_boost(post):
    """
    Rewards posts where comments are high relative to likes.
    Comments require effort — high ratio signals compelling content.
    """
    likes = post.get("likesCount", 0)
    comments = post.get("commentsCount", 0)
    if likes == 0:
        return 0
    ratio = comments / likes
    return min(ratio * 0.5, 1.0)


def freshness_tier(age_hours):
    """
    Tiered freshness multiplier.
    New posts get explicit visibility boost in their first window.
    """
    if age_hours < 1:
        return 1.5
    elif age_hours < 6:
        return 1.2
    elif age_hours < 24:
        return 1.0
    elif age_hours < 72:
        return 0.8
    else:
        return 0.6


def preference_score(post, user_preferences):
    category = post.get("category", "general")
    return user_preferences.get(category, 0)


def apply_diversity_penalty(scored_posts, penalty_factor=0.15):
    """
    Reduces score for posts in overrepresented categories.
    Prevents the feed from being monopolized by one aesthetic.
    """
    category_count = {}
    result = []
    for post, score in scored_posts:
        category = post.get("category", "general")
        count = category_count.get(category, 0)
        penalty = penalty_factor * count
        adjusted_score = score * (1 - penalty)
        category_count[category] = count + 1
        result.append((post, adjusted_score))
    return result


def calculate_score(post, user_preferences):
    likes = post.get("likesCount", 0)
    comments = post.get("commentsCount", 0)
    total_interactions = likes + comments
    age_hours = get_post_age_hours(post.get("createdAt"))

    # Wilson score — statistical confidence in engagement
    w_score = wilson_score(likes, max(total_interactions, 1))

    # Velocity — how fast engagement is coming in
    v_score = normalize(velocity_score(post), max_value=5)

    # Comment to like ratio boost
    ratio_boost = engagement_ratio_boost(post)

    # Freshness tier multiplier
    freshness = freshness_tier(age_hours)

    # User preference score
    p_score = normalize(preference_score(post, user_preferences), max_value=10)

    # Small exploration factor
    exploration = random.uniform(0, 0.05)

    # Final weighted combination
    score = (
        (w_score * 0.35) +
        (v_score * 0.25) +
        (ratio_boost * 0.10) +
        (p_score * 0.20) +
        (exploration * 0.10)
    ) * freshness

    return score


def rank_posts(posts, user_preferences):
    scored = [(post, calculate_score(post, user_preferences)) for post in posts]
    scored = apply_diversity_penalty(scored)
    return [post for post, score in sorted(scored, key=lambda x: x[1], reverse=True)]


def get_trending(posts):
    """
    Trending uses velocity score so fast rising posts rank higher
    than posts with high total engagement but slow recent activity.
    """
    return sorted(
        posts,
        key=lambda p: velocity_score(p),
        reverse=True
    )
