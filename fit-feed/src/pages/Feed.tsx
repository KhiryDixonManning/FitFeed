import { useState, useEffect } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import PostCard from "../components/PostCard";
import { getRankedFeed, recordInteraction } from "../feedService";
import { toggleLike, type Post } from "../FirebaseDB";
import { CATEGORIES } from "../constants/categories";

interface FeedProps {
  uid: string;
}

export default function Feed({ uid }: FeedProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiOnline, setApiOnline] = useState(true);
  const [likingIds, setLikingIds] = useState<Set<string>>(new Set());
  const [authorEmails, setAuthorEmails] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'foryou' | 'discover'>('foryou');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  useEffect(() => {
    fetch("/api/health")
      .then(res => { if (!res.ok) setApiOnline(false); })
      .catch(() => setApiOnline(false));
  }, []);

  useEffect(() => {
    const fetchFeed = async () => {
      setLoading(true);
      const ranked = await getRankedFeed(uid);
      setPosts(ranked);

      // Batch-fetch author emails so posts show readable names instead of UIDs
      const emailMap: Record<string, string> = {};
      await Promise.all(
        ranked.map(async (post) => {
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
    fetchFeed();
  }, [uid]);

  const handleLike = async (post: Post) => {
    if (likingIds.has(post.id)) return;

    const wasLiked = post.likedBy?.includes(uid) ?? false;

    // Optimistic update
    setPosts(prev => prev.map(p =>
      p.id === post.id
        ? {
            ...p,
            likesCount: wasLiked ? (p.likesCount || 1) - 1 : (p.likesCount || 0) + 1,
            likedBy: wasLiked
              ? p.likedBy?.filter(id => id !== uid)
              : [...(p.likedBy || []), uid],
          }
        : p
    ));

    setLikingIds(prev => new Set(prev).add(post.id));

    const didLike = await toggleLike(post.id, uid);
    if (didLike && post.category) {
      await recordInteraction(uid, post.category, "like");
    }

    setLikingIds(prev => {
      const next = new Set(prev);
      next.delete(post.id);
      return next;
    });
  };

  const handleCommentAdded = (postId: string) => {
    setPosts(prev => prev.map(p =>
      p.id === postId ? { ...p, commentsCount: (p.commentsCount || 0) + 1 } : p
    ));
  };

  // Discover tab: sort by newest first; For You: keep ranked order
  const tabPosts = tab === 'discover'
    ? [...posts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : posts;

  const visiblePosts = selectedCategory === 'all'
    ? tabPosts
    : tabPosts.filter(p => p.category === selectedCategory);

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {!apiOnline && (
        <div className="bg-yellow-100 text-yellow-800 text-sm px-4 py-2 text-center">
          Ranking server is offline — showing unranked posts
        </div>
      )}

      <div className="pt-4">
        {/* For You / Discover toggle */}
        <div className="flex gap-2 px-4 md:px-6 mb-4">
          <button
            onClick={() => setTab('foryou')}
            className={`flex-1 md:flex-none px-4 py-1.5 rounded-full text-sm font-medium transition ${
              tab === 'foryou'
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--text)] hover:text-[var(--text-h)]'
            }`}
          >
            For You
          </button>
          <button
            onClick={() => setTab('discover')}
            className={`flex-1 md:flex-none px-4 py-1.5 rounded-full text-sm font-medium transition ${
              tab === 'discover'
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--text)] hover:text-[var(--text-h)]'
            }`}
          >
            Discover
          </button>
        </div>

        {/* Category filter bar — horizontal scroll on all sizes */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide -mx-4 px-4 md:mx-0 md:px-6">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition shrink-0 ${
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
              className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition shrink-0 ${
                selectedCategory === cat
                  ? 'bg-[var(--accent)] text-white'
                  : 'border border-[var(--border)] text-[var(--text)] hover:text-[var(--text-h)]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Posts */}
        {loading ? (
          <div className="text-center text-gray-400 py-12">Loading feed...</div>
        ) : visiblePosts.length === 0 ? (
          <div className="text-center text-gray-400 py-12 px-4">
            {posts.length === 0 ? 'No posts yet. Be the first to share a fit!' : 'No posts in this category yet.'}
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 md:px-6">
            {visiblePosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                uid={uid}
                authorEmail={authorEmails[post.authorId] || post.authorId}
                isLiked={post.likedBy?.includes(uid) ?? false}
                onLike={() => handleLike(post)}
                liking={likingIds.has(post.id)}
                onCommentAdded={handleCommentAdded}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
