import { useState, useEffect, useRef } from "react";
import { collection, onSnapshot, query, orderBy, doc, getDoc, type Firestore } from "firebase/firestore";
import { db } from "../../firebase";
import PostCard from "../components/PostCard";
import { recordInteraction } from "../feedService";
import { toggleLike, getUserPreferences, type Post } from "../FirebaseDB";
import { CATEGORIES } from "../constants/categories";
import { PYTHON_API } from '../config';

const fetchAuthorEmails = async (posts: Post[], database: Firestore, existingEmails: Record<string, string> = {}): Promise<Record<string, string>> => {
  const emailMap: Record<string, string> = {};
  await Promise.all(
    posts.map(async (post) => {
      if (!post.authorId || existingEmails[post.authorId] || emailMap[post.authorId]) return;
      try {
        const userDoc = await getDoc(doc(database, 'users', post.authorId));
        if (userDoc.exists() && userDoc.data().email) {
          emailMap[post.authorId] = userDoc.data().email;
        } else {
          emailMap[post.authorId] = `user_${post.authorId.slice(0, 6)}`;
        }
      } catch {
        emailMap[post.authorId] = `user_${post.authorId.slice(0, 6)}`;
      }
    })
  );
  return emailMap;
};

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
  const rankDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authorEmailsRef = useRef<Record<string, string>>({});

  // Keep ref in sync with state so callbacks always see the latest cache
  useEffect(() => {
    authorEmailsRef.current = authorEmails;
  }, [authorEmails]);

  useEffect(() => {
    fetch(`${PYTHON_API}/health`)
      .then(res => { if (!res.ok) setApiOnline(false); })
      .catch(() => setApiOnline(false));
  }, []);

  useEffect(() => {
    const postsRef = collection(db, 'posts');
    const q = query(postsRef, orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const posts: Post[] = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data(),
        createdAt: d.data().createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
      } as Post));

      // Debounce ranking so rapid bursts of likes don't hammer Flask
      if (rankDebounceRef.current) clearTimeout(rankDebounceRef.current);
      rankDebounceRef.current = setTimeout(async () => {
        try {
          const userPreferences = await getUserPreferences(uid);
          const response = await fetch(`${PYTHON_API}/rank`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posts, userPreferences }),
          });
          if (response.ok) {
            const ranked = await response.json();
            setPosts(ranked);
            const emails = await fetchAuthorEmails(ranked, db, authorEmailsRef.current);
            setAuthorEmails(prev => ({ ...prev, ...emails }));
          } else {
            setPosts(posts);
            const emails = await fetchAuthorEmails(posts, db, authorEmailsRef.current);
            setAuthorEmails(prev => ({ ...prev, ...emails }));
          }
        } catch {
          setPosts(posts);
          const emails = await fetchAuthorEmails(posts, db, authorEmailsRef.current);
          setAuthorEmails(prev => ({ ...prev, ...emails }));
        }

        setLoading(false);
      }, 500);
    });

    // Clean up listener and any pending debounce when component unmounts
    return () => {
      unsubscribe();
      if (rankDebounceRef.current) clearTimeout(rankDebounceRef.current);
    };
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
    <div className="min-h-screen bg-[var(--bg)] pb-24 md:pb-6">
      {!apiOnline && (
        <div className="bg-yellow-100 text-yellow-800 text-sm px-4 py-2 text-center">
          Ranking server is offline — showing unranked posts
        </div>
      )}

      <div className="pt-4 max-w-7xl mx-auto">
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
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6 px-4 md:px-6">
            {visiblePosts.map((post) => (
              <div key={post.id} className="w-full max-w-2xl mx-auto">
                <PostCard
                  post={post}
                  uid={uid}
                  authorEmail={authorEmails[post.authorId] || post.authorId}
                  isLiked={post.likedBy?.includes(uid) ?? false}
                  onLike={() => handleLike(post)}
                  liking={likingIds.has(post.id)}
                  onCommentAdded={handleCommentAdded}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
