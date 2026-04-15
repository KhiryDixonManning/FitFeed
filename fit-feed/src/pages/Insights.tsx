import { useEffect, useState } from 'react';
import { getPosts, type Post } from '../FirebaseDB';
import { auth } from '../../firebase';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell,
} from 'recharts';

interface InsightsProps {
  uid: string;
}

export default function Insights({ uid }: InsightsProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const all = await getPosts();
      const mine = all.filter(p => p.authorId === uid);
      setPosts(mine);
      setLoading(false);
    };
    load();
  }, [uid]);

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-[var(--text)] animate-pulse">Loading insights...</p>
    </div>
  );

  if (posts.length === 0) return (
    <div className="max-w-2xl mx-auto p-6 text-center pb-24">
      <h2 className="text-2xl font-bold text-[var(--text-h)] mb-2">Creator Insights</h2>
      <p className="text-[var(--text)] text-sm">Upload posts to start seeing your insights.</p>
    </div>
  );

  const totalLikes = posts.reduce((sum, p) => sum + (p.likesCount || 0), 0);
  const totalComments = posts.reduce((sum, p) => sum + (p.commentsCount || 0), 0);
  const totalEngagement = totalLikes + totalComments;
  const avgEngagement = posts.length > 0 ? (totalEngagement / posts.length).toFixed(1) : '0';

  const topPosts = [...posts]
    .sort((a, b) => ((b.likesCount || 0) + (b.commentsCount || 0)) - ((a.likesCount || 0) + (a.commentsCount || 0)))
    .slice(0, 3);

  const categoryEngagement: Record<string, number> = {};
  posts.forEach(p => {
    if (p.category) {
      categoryEngagement[p.category] = (categoryEngagement[p.category] || 0)
        + (p.likesCount || 0) + (p.commentsCount || 0);
    }
  });
  const categoryChartData = Object.entries(categoryEngagement)
    .map(([category, engagement]) => ({ category, engagement }))
    .sort((a, b) => b.engagement - a.engagement);

  const bestCategory = categoryChartData[0]?.category || 'None yet';

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-6 pb-24 md:pb-6 animate-fade-in text-left">
      <h2 className="text-2xl font-bold text-[var(--text-h)] mb-1">Creator Insights</h2>
      <p className="text-xs text-[var(--text)] mb-6">@{auth.currentUser?.email}</p>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
        {[
          { label: 'Total Posts', value: posts.length },
          { label: 'Total Likes', value: totalLikes },
          { label: 'Total Comments', value: totalComments },
          { label: 'Avg Engagement', value: avgEngagement },
        ].map(({ label, value }) => (
          <div key={label} className="border border-[var(--border)] rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-[var(--accent)]">{value}</p>
            <p className="text-xs text-[var(--text)] mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Best Category */}
      <div className="border border-[var(--border)] rounded-xl p-4 mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--text-h)]">Best Performing Style</p>
          <p className="text-xs text-[var(--text)]">Based on total engagement</p>
        </div>
        <span className="bg-[var(--accent)] text-white text-xs font-medium rounded-full px-3 py-1 capitalize">
          {bestCategory}
        </span>
      </div>

      {/* Engagement by Category Chart */}
      {categoryChartData.length > 0 && (
        <div className="border border-[var(--border)] rounded-xl p-4 mb-6">
          <h3 className="text-sm font-semibold text-[var(--text-h)] mb-4">Engagement by Style</h3>
          <div className="w-full h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryChartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="category" tick={{ fontSize: 9, fill: 'var(--text)' }} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text)' }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="engagement" radius={[4, 4, 0, 0]}>
                  {categoryChartData.map((_, index) => (
                    <Cell key={index} fill={index === 0 ? '#aa3bff' : 'var(--border)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Top Posts */}
      <div className="border border-[var(--border)] rounded-xl p-4 mb-6">
        <h3 className="text-sm font-semibold text-[var(--text-h)] mb-4">Top Performing Posts</h3>
        <div className="flex flex-col gap-3">
          {topPosts.map((post, index) => (
            <div key={post.id} className="flex items-center gap-3">
              <span className="text-lg font-bold text-[var(--accent)] w-6 shrink-0">#{index + 1}</span>
              {post.imageUrl && (
                <img
                  src={post.imageUrl}
                  alt="outfit"
                  className="w-12 h-12 object-cover rounded-lg shrink-0"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--text-h)] truncate">{post.content || 'No caption'}</p>
                {post.category && (
                  <span className="text-xs bg-[var(--accent)] text-white rounded-full px-2 py-0.5 capitalize">
                    {post.category}
                  </span>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold text-[var(--accent)]">
                  {(post.likesCount || 0) + (post.commentsCount || 0)}
                </p>
                <p className="text-xs text-[var(--text)]">pts</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* AI Aesthetic Breakdown */}
      {posts.some(p => p.analyzed) && (() => {
        const aestheticTotals: Record<string, number> = {};
        let analyzedCount = 0;
        posts.forEach(p => {
          if (p.aestheticScores && p.analyzed) {
            analyzedCount++;
            Object.entries(p.aestheticScores).forEach(([key, val]) => {
              aestheticTotals[key] = (aestheticTotals[key] || 0) + val;
            });
          }
        });
        if (analyzedCount === 0) return null;
        const averaged = Object.entries(aestheticTotals)
          .map(([key, total]) => ({ aesthetic: key, score: total / analyzedCount }))
          .filter(item => item.score > 0.1)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        return (
          <div className="border border-[var(--border)] rounded-xl p-4">
            <h3 className="text-sm font-semibold text-[var(--text-h)] mb-1">AI Style Breakdown</h3>
            <p className="text-xs text-[var(--text)] mb-4">Based on your analyzed posts</p>
            <div className="flex flex-col gap-2">
              {averaged.map(({ aesthetic, score }) => (
                <div key={aesthetic} className="flex items-center gap-3">
                  <span className="text-xs text-[var(--text)] capitalize w-28 shrink-0">{aesthetic}</span>
                  <div className="flex-1 h-2 bg-[var(--border)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent)] rounded-full transition-all duration-500"
                      style={{ width: `${Math.round(score * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-[var(--text)] w-8 text-right">
                    {Math.round(score * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
