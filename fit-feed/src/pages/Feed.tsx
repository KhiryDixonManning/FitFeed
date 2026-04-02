import { useState, useEffect } from 'react';
import { getRankedFeed, recordInteraction } from '../feedService';
import { type Post } from '../FirebaseDB';
import { CATEGORIES } from '../constants/categories';

interface Props {
  uid: string;
}

export default function Feed({ uid }: Props) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    getRankedFeed(uid).then(data => {
      setPosts(data);
      setLoading(false);
    });
  }, [uid]);

  const handleLike = async (post: Post) => {
    if (!post.category) return;
    await recordInteraction(uid, post.category, 'like');
    setPosts(prev =>
      prev.map(p => p.id === post.id ? { ...p, likesCount: (p.likesCount ?? 0) + 1 } : p)
    );
  };

  const filtered = activeCategory
    ? posts.filter(p => p.category === activeCategory)
    : posts;

  if (loading) return <div className="p-8 text-center text-[var(--text)]">Loading feed...</div>;

  return (
    <div className="px-6 py-4 text-left">
      {/* Category filter bar */}
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
        <p className="text-center text-[var(--text)] py-12">
          {posts.length === 0 ? 'No posts yet. Be the first to share a fit!' : 'No posts in this category.'}
        </p>
      ) : (
        <div className="flex flex-col gap-6 max-w-lg mx-auto">
          {filtered.map(post => (
            <div
              key={post.id}
              className="border border-[var(--border)] rounded-xl overflow-hidden bg-[var(--bg)] shadow-[var(--shadow)]"
            >
              {post.imageUrl && (
                <img
                  src={post.imageUrl}
                  alt={post.content ?? 'outfit'}
                  className="w-full object-cover aspect-[4/5]"
                />
              )}
              <div className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  {post.category && (
                    <span className="bg-[var(--accent)] text-white rounded-full px-2 py-0.5 text-xs capitalize">
                      {post.category}
                    </span>
                  )}
                </div>
                {post.content && (
                  <p className="text-[var(--text-h)] text-sm mb-3">{post.content}</p>
                )}
                {post.outfitBreakdown && (
                  <p className="text-[var(--text)] text-xs mb-3 leading-relaxed">{post.outfitBreakdown}</p>
                )}
                <div className="flex items-center gap-4 text-[var(--text)] text-sm">
                  <button
                    onClick={() => handleLike(post)}
                    className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                  >
                    ♥ {post.likesCount ?? 0}
                  </button>
                  <span className="flex items-center gap-1">
                    💬 {post.commentsCount ?? 0}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
