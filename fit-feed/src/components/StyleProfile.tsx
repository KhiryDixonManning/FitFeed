import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from 'recharts';

interface StyleProfileProps {
  preferences: Record<string, number>;
}

// All 10 app categories shown on the radar
const RADAR_CATEGORIES = [
  'streetwear',
  'vintage',
  'minimalist',
  'y2k',
  'alternative',
  'cottagecore',
  'athleisure',
  'preppy',
  'western',
  'business casual',
];

// Transforms raw preference scores into normalized chart data
function buildChartData(preferences: Record<string, number>) {
  const values = RADAR_CATEGORIES.map(cat => preferences[cat] || 0);
  const max = Math.max(...values, 1); // avoid divide by zero

  return RADAR_CATEGORIES.map((cat, i) => ({
    category: cat.charAt(0).toUpperCase() + cat.slice(1),
    value: parseFloat((values[i] / max).toFixed(2)),
    raw: values[i],
  }));
}

// Returns the category with the highest score
function getTopCategory(preferences: Record<string, number>): string | null {
  const entries = Object.entries(preferences);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

// Returns top N categories sorted by score for the bar section
function getTopCategories(preferences: Record<string, number>, n = 5) {
  return Object.entries(preferences)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

export default function StyleProfile({ preferences }: StyleProfileProps) {
  const hasData = Object.keys(preferences).length > 0 &&
    Object.values(preferences).some(v => v > 0);

  if (!hasData) {
    return (
      <div className="border border-[var(--border)] rounded-xl p-6 text-center animate-fade-in">
        <h3 className="text-lg font-semibold text-[var(--text-h)] mb-1">Style Profile</h3>
        <p className="text-xs text-[var(--text)] mb-4">Based on your interactions</p>
        <p className="text-sm text-[var(--text)] opacity-60">
          Interact with posts to build your style profile
        </p>
      </div>
    );
  }

  const chartData = buildChartData(preferences);
  const topCategory = getTopCategory(preferences);
  const topCategories = getTopCategories(preferences);
  const maxScore = Math.max(...Object.values(preferences), 1);

  return (
    <div className="border border-[var(--border)] rounded-xl p-6 animate-fade-in">
      {/* Header */}
      <h3 className="text-lg font-semibold text-[var(--text-h)] mb-1">Style Profile</h3>
      <p className="text-xs text-[var(--text)] mb-1">Based on your interactions</p>

      {/* Top category badge */}
      {topCategory && (
        <div className="mb-4">
          <span className="text-xs bg-[var(--accent)] text-white rounded-full px-3 py-1 font-medium capitalize">
            Top style: {topCategory}
          </span>
        </div>
      )}

      {/* Radar Chart */}
      <div className="w-full h-48 sm:h-56 mb-6">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
            <PolarGrid stroke="var(--border)" />
            <PolarAngleAxis
              dataKey="category"
              tick={{ fontSize: 9, fill: 'var(--text)' }}
            />
            <Radar
              name="Style"
              dataKey="value"
              stroke="#aa3bff"
              fill="#aa3bff"
              fillOpacity={0.25}
              strokeWidth={2}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Horizontal bars for top categories */}
      <div className="flex flex-col gap-2">
        {topCategories.map(([category, score]) => (
          <div key={category} className="flex items-center gap-3">
            <span className="text-xs text-[var(--text)] capitalize w-20 sm:w-28 shrink-0">
              {category}
            </span>
            <div className="flex-1 h-2 bg-[var(--border)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--accent)] rounded-full transition-all duration-500"
                style={{ width: `${Math.round((score / maxScore) * 100)}%` }}
              />
            </div>
            <span className="text-xs text-[var(--text)] w-12 text-right">
              {score} pts
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
