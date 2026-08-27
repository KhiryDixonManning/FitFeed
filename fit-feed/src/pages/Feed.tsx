import { useState, useEffect, useRef } from "react";
import { getFollowingIds, getSavedPostIds, savePost, unsavePost } from '../FirebaseDB';
import { collection, onSnapshot, query, orderBy, doc, getDoc, type Firestore } from "firebase/firestore";
import { db } from "../../firebase";
import PostCard from "../components/PostCard";
import EmptyState from "../components/EmptyState";
import { PostCardSkeleton } from "../components/Skeletons";
import { useNavigate } from "react-router-dom";
import { recordInteraction } from "../feedService";
import { toggleLike, getUserPreferences, type Post } from "../FirebaseDB";
import { CATEGORIES } from "../constants/categories";
import { PYTHON_API } from '../config';

const fetchAuthorEmails = async (posts: Post[], database: Firestore, existingEmails: Record<string, string> = {}): Promise<Record<string, string>> => {
  const emailMap: Record<string, string> = {};
  // Dedupe BEFORE fanning out: the map callbacks all start before any
  // emailMap write lands, so checking emailMap inside them can't prevent
  // duplicate reads — N posts by one author used to mean N user-doc reads.
  const authorIds = [...new Set(posts.map(p => p.authorId))]
    .filter(id => id && !existingEmails[id]);
  await Promise.all(
    authorIds.map(async (authorId) => {
      try {
        const userDoc = await getDoc(doc(database, 'users', authorId));
        if (userDoc.exists()) {
          const data = userDoc.data();
          if (data.username) {
            emailMap[authorId] = data.username;
          } else if (data.email) {
            emailMap[authorId] = data.email.split('@')[0];
          } else {
            emailMap[authorId] = `user_${authorId.slice(0, 6)}`;
          }
        } else {
          emailMap[authorId] = `user_${authorId.slice(0, 6)}`;
        }
      } catch {
        emailMap[authorId] = `user_${authorId.slice(0, 6)}`;
      }
    })
  );
  return emailMap;
};

interface FeedProps {
  uid: string;
}

export default function Feed({ uid }: FeedProps) {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiOnline, setApiOnline] = useState(true);
  const [likingIds, setLikingIds] = useState<Set<string>>(new Set());
  const [authorEmails, setAuthorEmails] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'foryou' | 'discover' | 'following'>('foryou');
  const [followingIds, setFollowingIds] = useState<string[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const isFirstLoadRef = useRef(true);
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
    getFollowingIds(uid).then(ids => setFollowingIds(ids));
    getSavedPostIds(uid).then(ids => setSavedIds(new Set(ids)));
  }, [uid]);

  useEffect(() => {
    const postsRef = collection(db, 'posts');
    const q = query(postsRef, orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const snapshotPosts: Post[] = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data(),
        createdAt: d.data().createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
      } as Post));

      // Show unranked posts immediately on first load so feed appears fast
      if (snapshotPosts.length > 0 && isFirstLoadRef.current) {
        setPosts(snapshotPosts);
        setLoading(false);
        isFirstLoadRef.current = false;
      }

      // Fetch author emails for any new authors
      const emails = await fetchAuthorEmails(snapshotPosts, db, authorEmailsRef.current);
      setAuthorEmails(prev => ({ ...prev, ...emails }));

      // Debounce ranking so rapid bursts of likes don't hammer Flask
      if (rankDebounceRef.current) clearTimeout(rankDebounceRef.current);
      rankDebounceRef.current = setTimeout(async () => {
        try {
          const userPreferences = await getUserPreferences(uid);
          const response = await fetch(`${PYTHON_API}/rank`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posts: snapshotPosts, userPreferences }),
          });
          if (response.ok) {
            const ranked = await response.json();
            setPosts(ranked);
          } else {
            setPosts(snapshotPosts);
          }
        } catch {
          setPosts(snapshotPosts);
        }
        setLoading(false);
      }, 300);
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

  const handleToggleSave = async (post: Post) => {
    if (savingIds.has(post.id)) return;
    const wasSaved = savedIds.has(post.id);

    setSavedIds(prev => {
      const next = new Set(prev);
      wasSaved ? next.delete(post.id) : next.add(post.id);
      return next;
    });
    setSavingIds(prev => new Set(prev).add(post.id));

    if (wasSaved) {
      await unsavePost(uid, post.id);
    } else {
      await savePost(uid, post.id);
    }

    setSavingIds(prev => {
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

  // Discover: newest first; Following: filter to followed users; For You: ranked order
  const tabPosts = tab === 'discover'
    ? [...posts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : tab === 'following'
    ? posts.filter(p => followingIds.includes(p.authorId))
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
          <button
            onClick={() => setTab('following')}
            className={`flex-1 md:flex-none px-4 py-1.5 rounded-full text-sm font-medium transition ${
              tab === 'following'
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--text)] hover:text-[var(--text-h)]'
            }`}
          >
            Following
          </button>
        </div>

        {/* Category filter bar — horizontal scroll on all sizes */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide -mx-4 px-4 md:mx-0 md:px-6">
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

        {/* Posts */}
        {loading ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6 px-4 md:px-6">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="w-full max-w-2xl mx-auto">
                <PostCardSkeleton />
              </div>
            ))}
          </div>
        ) : visiblePosts.length === 0 ? (
          tab === 'following' && followingIds.length === 0 ? (
            <EmptyState
              title="Your circle starts here"
              message="Follow people whose style you admire and their fits will land in this tab."
              action={{ label: 'Browse Discover', onClick: () => setTab('discover') }}
            />
          ) : posts.length === 0 ? (
            <EmptyState
              title="The feed is waiting on you"
              message="Be the first to share a fit — FitFeed reads its colors, garments, and aesthetic the moment it lands."
              action={{ label: 'Upload a fit', onClick: () => navigate('/upload') }}
            />
          ) : selectedCategory !== 'all' ? (
            <EmptyState
              title={`Nothing in ${selectedCategory} yet`}
              message="No fits have been posted in this category so far."
              action={{ label: 'Show all styles', onClick: () => setSelectedCategory('all') }}
            />
          ) : (
            <EmptyState
              title="Quiet in here"
              message="The people you follow haven't posted yet. Discover has plenty in the meantime."
              action={{ label: 'Browse Discover', onClick: () => setTab('discover') }}
            />
          )
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
                  isSaved={savedIds.has(post.id)}
                  onToggleSave={() => handleToggleSave(post)}
                  saving={savingIds.has(post.id)}
                  rankingFactors={tab === 'foryou' ? post._rankingFactors : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
