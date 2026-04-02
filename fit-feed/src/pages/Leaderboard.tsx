import { useState, useEffect } from 'react';
import { getTrendingFeed } from '../feedService';
import { type Post } from '../FirebaseDB';
import { CATEGORIES } from '../constants/categories';

export default function Leaderboard() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    getTrendingFeed().then(data => {
      setPosts(data);
      setLoading(false);
    });
  }, []);

  const filtered = activeCategory
    ? posts.filter(p => p.category === activeCategory)
    : posts;

  if (loading) return <div className="p-8 text-center text-[var(--text)]">Loading leaderboard...</div>;

  return (
    <div className="px-6 py-4 text-left">
      <h2 className="mb-6">Trending Fits</h2>

      {/* Category filter */}
      <div className="flex gap-2 flex-wrap mb-6">
        <button
          onClick={() => setActiveCategory(null)}
          className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
            activeCategory === null
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--accent-bg)] text-[var(--text)] hover:text-[var(--text-h)]'
          }`}
        >
          All
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
            className={`px-3 py-1 rounded-full text-sm font-medium capitalize transition-colors ${
              activeCategory === cat
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--accent-bg)] text-[var(--text)] hover:text-[var(--text-h)]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-center text-[var(--text)] py-12">No trending posts yet.</p>
      ) : (
        <div className="flex flex-col gap-3 max-w-2xl mx-auto">
          {filtered.map((post, index) => {
            const engagement = (post.likesCount ?? 0) + (post.commentsCount ?? 0);
            return (
              <div
                key={post.id}
                className="flex items-center gap-4 border border-[var(--border)] rounded-xl overflow-hidden bg-[var(--bg)] shadow-[var(--shadow)]"
              >
                {/* Rank */}
                <div className="flex items-center justify-center w-14 shrink-0 self-stretch border-r border-[var(--border)] text-2xl font-bold text-[var(--accent)]">
                  #{index + 1}
                </div>

                {/* Thumbnail */}
                {post.imageUrl && (
                  <img
                    src={post.imageUrl}
                    alt={post.content ?? 'outfit'}
                    className="w-20 h-20 object-cover shrink-0"
                  />
                )}

                {/* Info */}
                <div className="flex-1 py-3 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {post.category && (
                      <span className="bg-[var(--accent)] text-white rounded-full px-2 py-0.5 text-xs capitalize">
                        {post.category}
                      </span>
                    )}
                    <span className="text-xs text-[var(--text)]">
                      ♥ {post.likesCount ?? 0} · 💬 {post.commentsCount ?? 0}
                    </span>
                  </div>
                  {post.content && (
                    <p className="text-[var(--text-h)] text-sm truncate">{post.content}</p>
                  )}
                </div>

                {/* Engagement total */}
                <div className="pr-4 text-right shrink-0">
                  <span className="text-2xl font-bold text-[var(--accent)]">{engagement}</span>
                  <p className="text-xs text-[var(--text)]">points</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
