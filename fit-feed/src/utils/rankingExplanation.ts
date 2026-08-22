import type { RankingFactors } from '../FirebaseDB';

type ContributionKey = keyof RankingFactors['contributions'];

const REASON_LABELS: Record<ContributionKey, (factors: RankingFactors) => string> = {
  communityConfidence: () => 'Loved by the community',
  trendingVelocity: () => 'Trending right now',
  conversationBoost: () => 'Sparking conversation',
  styleMatch: (f) => f.matchedCategory ? `Matches your ${f.matchedCategory} style` : 'Matches your style',
};

// A contribution below this is noise, not a real reason to surface.
const CONTRIBUTION_THRESHOLD = 0.03;

// Turns the ranking engine's raw signal weights into 1-3 short,
// human-readable reasons, strongest first.
export function getRecommendationReasons(factors: RankingFactors): string[] {
  const entries = Object.entries(factors.contributions) as [ContributionKey, number][];

  const reasons = entries
    .filter(([, value]) => value > CONTRIBUTION_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key]) => REASON_LABELS[key](factors));

  if (factors.freshnessTier >= 1.2) {
    reasons.push('Just posted');
  }

  if (reasons.length === 0) {
    reasons.push('New to your feed');
  }

  return reasons;
}
