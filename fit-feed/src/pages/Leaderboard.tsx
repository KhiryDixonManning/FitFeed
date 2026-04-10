import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { getTrendingFeed } from '../feedService';
import { type Post } from '../FirebaseDB';
import { CATEGORIES } from '../constants/categories';

export default function Leaderboard() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [filtered, setFiltered] = useState<Post[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [authorEmails, setAuthorEmails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const trending = await getTrendingFeed();
      setPosts(trending);
      setFiltered(trending);

      // Batch-fetch author emails
      const emailMap: Record<string, string> = {};
      await Promise.all(
        trending.map(async (post) => {
          if (!emailMap[post.authorId]) {
            try {
              const userDoc = await getDoc(doc(db, 'users', post.authorId));
              emailMap[post.authorId] = userDoc.exists()
                ? (userDoc.data().email || post.authorId)
                : post.authorId;
            } catch {
              emailMap[post.authorId] = post.authorId;
            }
          }
        })
      );
      setAuthorEmails(emailMap);
      setLoading(false);
    };
    load();
  }, []);

  useEffect(() => {
    setFiltered(
      selectedCategory === 'all'
        ? posts
        : posts.filter(p => p.category === selectedCategory)
    );
  }, [selectedCategory, posts]);

  if (loading) return <div className="p-8 text-center text-[var(--text)]">Loading leaderboard...</div>;

  return (
    <div className="max-w-2xl mx-auto p-6 text-left">
      <h2 className="text-2xl font-bold text-[var(--text-h)] mb-4">Trending</h2>

      {/* Category filter */}
      <div className="flex gap-2 flex-wrap mb-6">
        <button
          onClick={() => setSelectedCategory('all')}
          className={`px-3 py-1 rounded-full text-xs font-medium transition ${
            selectedCategory === 'all'
              ? 'bg-[var(--accent)] text-white'
              : 'border border-[var(--border)] text-[var(--text)] hover:text-[var(--text-h)]'
          }`}
        >
          All
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition ${
              selectedCategory === cat
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--text)] hover:text-[var(--text-h)]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-[var(--text)] text-sm">No posts in this category yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {filtered.map((post, index) => {
            const engagement = (post.likesCount || 0) + (post.commentsCount || 0);
            return (
              <div
                key={post.id}
                className="flex gap-4 border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg)]"
              >
                {/* Rank */}
                <div className="flex items-center justify-center w-12 shrink-0 text-xl font-bold text-[var(--accent)]">
                  #{index + 1}
                </div>

                {/* Thumbnail */}
                {post.imageUrl && (
                  <img
                    src={post.imageUrl}
                    alt="outfit"
                    className="w-20 h-20 object-cover shrink-0"
                  />
                )}

                {/* Info */}
                <div className="p-3 flex flex-col justify-center gap-1 min-w-0 flex-1">
                  <p className="text-xs text-[var(--text)] truncate">
                    @{authorEmails[post.authorId] || post.authorId}
                  </p>
                  {post.content && (
                    <p className="text-sm text-[var(--text-h)] truncate">{post.content}</p>
                  )}
                  {post.category && (
                    <span className="text-xs bg-[var(--accent)] text-white rounded-full px-2 py-0.5 w-fit capitalize">
                      {post.category}
                    </span>
                  )}
                  <div className="flex gap-3 text-xs text-[var(--text)] mt-1">
                    <span>❤️ {post.likesCount || 0}</span>
                    <span>💬 {post.commentsCount || 0}</span>
                    <span className="text-[var(--accent)] font-medium">Score: {engagement}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
