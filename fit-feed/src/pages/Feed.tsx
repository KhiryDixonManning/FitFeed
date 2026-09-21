import { useState, useEffect, useRef, useCallback } from "react";
import { collection, onSnapshot, query, orderBy, limit as fsLimit, where, Timestamp } from "firebase/firestore";
import { db } from "../../firebase";
import { useNavigate } from "react-router-dom";
import PostCard from "../components/PostCard";
import EmptyState from "../components/EmptyState";
import { PostCardSkeleton } from "../components/Skeletons";
import { recordInteraction } from "../feedService";
import { toggleLike, getSavedPostIds, savePost, unsavePost, type Post } from "../FirebaseDB";
import { CATEGORIES } from "../constants/categories";
import { PYTHON_API } from "../config";
import { ApiError } from "../api";
import { fetchFeedPage, type FeedMode } from "../feedApi";
import { getPublicProfiles, displayHandle } from "../profileService";

interface FeedProps {
  uid: string;
}

// How many unseen posts we are willing to count for the "new posts" pill.
const NEW_POST_WATCH_LIMIT = 10;

export default function Feed({ uid }: FeedProps) {
  const navigate = useNavigate();

  const [posts, setPosts] = useState<Post[]>([]);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<FeedMode>('foryou');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [apiOnline, setApiOnline] = useState(true);
  const [newPostCount, setNewPostCount] = useState(0);

  const [likingIds, setLikingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  // Guards against a slow response for a tab the user already left.
  const requestRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  // State, not a ref: the realtime watch below keys off it, and an effect
  // dependency has to be something React can actually see change.
  const [newestLoaded, setNewestLoaded] = useState<Date | null>(null);

  useEffect(() => {
    fetch(`${PYTHON_API}/health`)
      .then(res => { if (!res.ok) setApiOnline(false); })
      .catch(() => setApiOnline(false));
  }, []);

  useEffect(() => {
    getSavedPostIds(uid).then(ids => setSavedIds(new Set(ids)));
  }, [uid]);

  /** Resolve author handles for any posts we have not seen before. */
  const resolveHandles = useCallback(async (incoming: Post[]) => {
    setHandles(previous => {
      const missing = [...new Set(incoming.map(p => p.authorId))]
        .filter(id => id && !previous[id]);
      if (missing.length > 0) {
        getPublicProfiles(missing).then(profiles => {
          setHandles(current => {
            const next = { ...current };
            for (const id of missing) next[id] = displayHandle(profiles[id], id);
            return next;
          });
        });
      }
      return previous;
    });
  }, []);

  const loadPage = useCallback(async (options: { append: boolean }) => {
    // Supersede any request still in flight for a previous tab/category.
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const seq = ++requestSeqRef.current;

    if (options.append) setLoadingMore(true);
    else { setLoading(true); setPosts([]); }
    setPageError(null);

    try {
      const page = await fetchFeedPage(
        {
          mode: tab,
          category: selectedCategory === 'all' ? null : selectedCategory,
          cursor: options.append ? cursor : null,
        },
        controller.signal
      );

      // A newer request has started since this one; drop the stale result.
      if (seq !== requestSeqRef.current) return;

      setPosts(previous => {
        if (!options.append) return page.posts;
        // Belt and braces against duplicates across page boundaries.
        const seen = new Set(previous.map(p => p.id));
        return [...previous, ...page.posts.filter(p => !seen.has(p.id))];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      resolveHandles(page.posts);

      if (!options.append && page.posts.length > 0) {
        const newest = page.posts
          .map(p => new Date(p.createdAt))
          .sort((a, b) => b.getTime() - a.getTime())[0];
        setNewestLoaded(newest);
        setNewPostCount(0);
      }
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      if (error instanceof ApiError && error.code === 'cancelled') return;
      setPageError(
        error instanceof ApiError ? error.message : 'Could not load the feed.'
      );
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [tab, selectedCategory, cursor, resolveHandles]);

  // Reload page one whenever the tab or category changes. cursor is
  // deliberately not a dependency: it changes as pages load.
  useEffect(() => {
    setCursor(null);
    loadPage({ append: false });
    return () => requestRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedCategory, uid]);

  // Bounded realtime: watch only for posts newer than what we loaded, capped
  // at a handful of documents, to drive a "new posts" pill. The old code held
  // an onSnapshot over the entire posts collection, which grew without limit.
  const feedIsEmpty = posts.length === 0;
  useEffect(() => {
    const newest = feedIsEmpty ? null : newestLoaded;
    if (!newest) return;

    const watch = query(
      collection(db, 'posts'),
      where('createdAt', '>', Timestamp.fromDate(newest)),
      orderBy('createdAt', 'desc'),
      fsLimit(NEW_POST_WATCH_LIMIT)
    );
    const unsubscribe = onSnapshot(
      watch,
      snapshot => setNewPostCount(snapshot.size),
      () => { /* a failed watch must never break the feed */ }
    );
    return unsubscribe;
  }, [newestLoaded, feedIsEmpty]);

  const handleLike = async (post: Post) => {
    if (likingIds.has(post.id)) return;
    const wasLiked = Boolean(post.likedByMe);

    setPosts(prev => prev.map(p =>
      p.id === post.id
        ? {
            ...p,
            likesCount: wasLiked ? Math.max((p.likesCount || 1) - 1, 0) : (p.likesCount || 0) + 1,
            likedByMe: !wasLiked,
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
      if (wasSaved) next.delete(post.id);
      else next.add(post.id);
      return next;
    });
    setSavingIds(prev => new Set(prev).add(post.id));

    if (wasSaved) await unsavePost(uid, post.id);
    else await savePost(uid, post.id);

    setSavingIds(prev => {
      const next = new Set(prev);
      next.delete(post.id);
      return next;
    });
  };

  // Hiding is per-viewer only: the signal never touches the post itself.
  const handleNotInterested = (postId: string) => {
    setPosts(prev => prev.filter(p => p.id !== postId));
  };

  const handleCommentAdded = (postId: string) => {
    setPosts(prev => prev.map(p =>
      p.id === postId ? { ...p, commentsCount: (p.commentsCount || 0) + 1 } : p
    ));
  };

  const tabButton = (mode: FeedMode, label: string) => (
    <button
      onClick={() => setTab(mode)}
      className={`flex-1 md:flex-none px-4 py-1.5 rounded-full text-sm font-medium transition ${
        tab === mode
          ? 'bg-[var(--accent)] text-white'
          : 'border border-[var(--border)] text-[var(--text)] hover:text-[var(--text-h)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] pb-24 md:pb-6">
      {!apiOnline && (
        <div className="bg-yellow-100 text-yellow-800 text-sm px-4 py-2 text-center">
          Feed service is offline — try again shortly
        </div>
      )}

      <div className="pt-4 max-w-7xl mx-auto">
        <div className="flex gap-2 px-4 md:px-6 mb-4">
          {tabButton('foryou', 'For You')}
          {tabButton('discover', 'Discover')}
          {tabButton('following', 'Following')}
        </div>

        {/* New-post indicator, driven by a bounded listener */}
        {newPostCount > 0 && !loading && (
          <div className="px-4 md:px-6 mb-4">
            <button
              onClick={() => { setCursor(null); loadPage({ append: false }); }}
              data-testid="new-posts-pill"
              className="w-full md:w-auto border border-[var(--accent)] text-[var(--accent)] rounded-full px-4 py-1.5 text-sm font-medium hover:bg-[var(--accent-bg)] transition"
            >
              {newPostCount === NEW_POST_WATCH_LIMIT ? `${newPostCount}+ new fits` : `${newPostCount} new ${newPostCount === 1 ? 'fit' : 'fits'}`} — tap to refresh
            </button>
          </div>
        )}

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

        {loading ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6 px-4 md:px-6">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="w-full max-w-2xl mx-auto">
                <PostCardSkeleton />
              </div>
            ))}
          </div>
        ) : pageError && posts.length === 0 ? (
          <EmptyState
            title="The feed didn't load"
            message={pageError}
            action={{ label: 'Try again', onClick: () => loadPage({ append: false }) }}
          />
        ) : posts.length === 0 ? (
          tab === 'following' ? (
            <EmptyState
              title="Your circle starts here"
              message="Follow people whose style you admire and their fits will land in this tab."
              action={{ label: 'Browse Discover', onClick: () => setTab('discover') }}
            />
          ) : selectedCategory !== 'all' ? (
            <EmptyState
              title={`Nothing in ${selectedCategory} yet`}
              message="No fits have been posted in this category so far."
              action={{ label: 'Show all styles', onClick: () => setSelectedCategory('all') }}
            />
          ) : (
            <EmptyState
              title="The feed is waiting on you"
              message="Be the first to share a fit — FitFeed reads its colors, garments, and aesthetic the moment it lands."
              action={{ label: 'Upload a fit', onClick: () => navigate('/upload') }}
            />
          )
        ) : (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6 px-4 md:px-6">
              {posts.map((post) => (
                <div key={post.id} className="w-full max-w-2xl mx-auto">
                  <PostCard
                    post={post}
                    uid={uid}
                    authorEmail={handles[post.authorId] || post.authorId}
                    isLiked={Boolean(post.likedByMe)}
                    onLike={() => handleLike(post)}
                    liking={likingIds.has(post.id)}
                    onCommentAdded={handleCommentAdded}
                    isSaved={savedIds.has(post.id)}
                    onToggleSave={() => handleToggleSave(post)}
                    saving={savingIds.has(post.id)}
                    rankingFactors={tab === 'foryou' ? post._rankingFactors : undefined}
                    onNotInterested={handleNotInterested}
                  />
                </div>
              ))}
            </div>

            <div className="px-4 md:px-6 mt-6 flex flex-col items-center gap-3">
              {loadingMore && (
                <div className="w-full grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6">
                  {[0, 1].map(i => (
                    <div key={i} className="w-full max-w-2xl mx-auto">
                      <PostCardSkeleton />
                    </div>
                  ))}
                </div>
              )}

              {pageError && posts.length > 0 && (
                <p className="text-sm text-[var(--text)]">{pageError}</p>
              )}

              {hasMore && !loadingMore && (
                <button
                  onClick={() => loadPage({ append: true })}
                  data-testid="load-more"
                  className="border border-[var(--border)] rounded-full px-5 py-2 text-sm font-medium text-[var(--text-h)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
                >
                  {pageError ? 'Retry' : 'Load more'}
                </button>
              )}

              {!hasMore && !loadingMore && posts.length > 0 && (
                <p className="text-xs uppercase tracking-widest text-[var(--text)] opacity-50 py-2">
                  You're all caught up
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
