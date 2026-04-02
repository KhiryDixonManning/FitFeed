# recommendation_engine.py

from utils import convert_timestamp
from datetime import datetime
import random
import math


# 🔹 Normalize values to avoid huge differences
def normalize(value, max_value=100):
    return min(value / max_value, 1)


def get_post_age_hours(created_at):
    created_time = convert_timestamp(created_at)
    now = datetime.utcnow()
    return (now - created_time).total_seconds() / 3600


# 🔹 Engagement score with weights
def engagement_score(post):
    likes = post.get("likesCount", 0)
    comments = post.get("commentsCount", 0)

    # Comments matter more than likes
    return (likes * 0.4) + (comments * 0.6)


# 🔹 Recency decay (exponential decay = more ML-like)
def recency_score(created_at):
    age_hours = get_post_age_hours(created_at)

    # Exponential decay
    return math.exp(-0.05 * age_hours)


# 🔹 User preference similarity
def preference_score(post, user_preferences):
    category = post.get("category", "general")

    return user_preferences.get(category, 0)


# 🔹 FINAL SCORE (combines everything)
def calculate_score(post, user_preferences):
    e_score = normalize(engagement_score(post), max_value=50)
    r_score = recency_score(post.get("createdAt"))
    p_score = normalize(preference_score(post, user_preferences), max_value=10)

    # Weighted combination (ML-style feature weights)
    score = (
        (e_score * 0.5) +
        (r_score * 0.3) +
        (p_score * 0.2)
    )

    # Exploration factor (prevents boring feeds)
    exploration = random.uniform(0, 0.1)
    score += exploration

    return score


def rank_posts(posts, user_preferences):
    return sorted(
        posts,
        key=lambda post: calculate_score(post, user_preferences),
        reverse=True
    )


def get_trending(posts):
    return sorted(
        posts,
        key=lambda p: engagement_score(p),
        reverse=True
    )