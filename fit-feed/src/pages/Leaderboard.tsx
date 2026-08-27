import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { getTrendingFeed } from '../feedService';
import { type Post } from '../FirebaseDB';
import { CATEGORIES } from '../constants/categories';
import PostImage from '../components/PostImage';
import EmptyState from '../components/EmptyState';
import { LeaderboardRowSkeleton } from '../components/Skeletons';

export default function Leaderboard() {
  const navigate = useNavigate();
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

      // Batch-fetch author display names (prefer username, fall back to email
      // prefix). Dedupe authorIds before fanning out — the concurrent callbacks
      // can't see each other's writes, so a per-post guard doesn't dedupe.
      const emailMap: Record<string, string> = {};
      const authorIds = [...new Set(trending.map(p => p.authorId).filter(Boolean))];
      await Promise.all(
        authorIds.map(async (authorId) => {
          try {
            const userDoc = await getDoc(doc(db, 'users', authorId));
            if (userDoc.exists()) {
              const data = userDoc.data();
              emailMap[authorId] = data.username
                ? data.username
                : data.email
                  ? data.email.split('@')[0]
                  : `user_${authorId.slice(0, 6)}`;
            } else {
              emailMap[authorId] = `user_${authorId.slice(0, 6)}`;
            }
          } catch {
            emailMap[authorId] = `user_${authorId.slice(0, 6)}`;
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

  if (loading) return (
    <div className="max-w-2xl mx-auto py-6 text-left pb-24 md:pb-6">
      <h2 className="text-2xl font-bold text-[var(--text-h)] mb-4 px-4 md:px-0">Aura Farmers 🌾</h2>
      <div className="flex gap-2 pb-2 mb-6 px-4 md:px-0 animate-pulse">
        {[10, 20, 16, 14].map((w, i) => (
          <div key={i} className="h-6 rounded-full bg-[var(--border)]" style={{ width: `${w * 4}px` }} />
        ))}
      </div>
      <div className="flex flex-col gap-3 px-4 md:px-0">
        {[0, 1, 2, 3, 4].map(i => <LeaderboardRowSkeleton key={i} />)}
      </div>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto py-6 text-left pb-24 md:pb-6">
      <h2 className="text-2xl font-bold text-[var(--text-h)] mb-4 px-4 md:px-0">Aura Farmers 🌾</h2>

      {/* Category filter — horizontal scroll on all sizes */}
      <div className="flex gap-2 overflow-x-auto pb-2 mb-6 scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
        <button
          onClick={() => setSelectedCategory('all')}
          className={`px-3 py-1 rounded-full text-xs font-medium transition shrink-0 whitespace-nowrap ${
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
            className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition shrink-0 whitespace-nowrap ${
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
        <EmptyState
          title={selectedCategory === 'all' ? 'No aura farmed yet' : `No ${selectedCategory} on the board`}
          message="Rankings build from likes and comments — the most-loved fits climb here."
          action={selectedCategory !== 'all'
            ? { label: 'Show all styles', onClick: () => setSelectedCategory('all') }
            : undefined}
          compact
        />
      ) : (
        <div className="flex flex-col gap-3 px-4 md:px-0">
          {filtered.map((post, index) => {
            const engagement = (post.likesCount || 0) + (post.commentsCount || 0);
            return (
              <div
                key={post.id}
                onClick={() => navigate(`/post/${post.id}`)}
                className="flex gap-3 border border-[var(--border)] rounded-xl overflow-hidden bg-[var(--bg)] cursor-pointer hover:border-[var(--accent)] transition-colors active:opacity-80"
              >
                {/* Rank */}
                <div className="flex items-center justify-center w-10 text-lg font-bold text-[var(--accent)] shrink-0">
                  #{index + 1}
                </div>

                {/* Thumbnail */}
                {post.imageUrl && (
                  <div className="relative shrink-0">
                    <PostImage
                      src={post.imageUrl}
                      alt="outfit"
                      className="w-16 h-16 sm:w-20 sm:h-20 object-cover"
                    />
                    <div className="absolute top-1 right-1 bg-black/80 backdrop-blur-sm rounded-full px-1.5 py-0.5 flex items-center gap-0.5">
                      <span className="text-white text-[9px]">◎</span>
                      <span className="text-white text-[9px] font-semibold">{engagement}</span>
                    </div>
                  </div>
                )}

                {/* Info */}
                <div className="p-2 flex flex-col justify-center gap-1 min-w-0 flex-1">
                  <p className="text-xs text-[var(--text)] truncate">
                    @{authorEmails[post.authorId] || post.authorId}
                  </p>
                  {post.content && (
                    <p className="text-sm text-[var(--text-h)] truncate">{post.content}</p>
                  )}
                  <div className="flex gap-2 text-xs text-[var(--text)] flex-wrap">
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
