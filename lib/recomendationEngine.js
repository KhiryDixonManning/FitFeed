// src/lib/recommendationEngine.js

export function getPostAgeInHours(createdAt) {
  const createdTime = createdAt?.toMillis
    ? createdAt.toMillis()
    : new Date(createdAt).getTime();

  const now = Date.now();
  return (now - createdTime) / (1000 * 60 * 60);
}

export function calculatePostScore(post, userPreferences = {}) {
  const likesCount = post.likesCount || 0;
  const commentsCount = post.commentsCount || 0;
  const category = post.category || "general";
  const ageInHours = getPostAgeInHours(post.createdAt || Date.now());

  let score = (likesCount * 2) + (commentsCount * 3);
  score -= ageInHours * 0.1;

  const categoryPreference = userPreferences[category] || 0;
  score += categoryPreference * 2;

  return score;
}

export function getRankedFeed(posts, userPreferences = {}) {
  return [...posts].sort((a, b) => {
    const scoreA = calculatePostScore(a, userPreferences);
    const scoreB = calculatePostScore(b, userPreferences);
    return scoreB - scoreA;
  });
}

export function getTrendingFeed(posts) {
  return [...posts].sort((a, b) => {
    const scoreA = (a.likesCount || 0) + (a.commentsCount || 0);
    const scoreB = (b.likesCount || 0) + (b.commentsCount || 0);
    return scoreB - scoreA;
  });
}

export function updateUserPreferences(currentPrefs = {}, category, interactionType) {
  const updatedPrefs = { ...currentPrefs };

  if (!updatedPrefs[category]) {
    updatedPrefs[category] = 0;
  }

  if (interactionType === "like") {
    updatedPrefs[category] += 1;
  }

  if (interactionType === "comment") {
    updatedPrefs[category] += 2;
  }

  return updatedPrefs;
}