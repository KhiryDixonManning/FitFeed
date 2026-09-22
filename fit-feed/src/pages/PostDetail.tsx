import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../../firebase';
import { type Post, toggleLike, getComments, addComment, type Comment, deletePost, isPostSaved, savePost, unsavePost } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import { formatAuthor } from '../utils/formatAuthor';
import PostImage from '../components/PostImage';
import EmptyState from '../components/EmptyState';
import { normalizeColor, isLightColor } from '../utils/color';
import { getPublicProfile, getPublicProfiles, displayHandle } from '../profileService';
import { hasLiked, getLikerIds } from '../interactionService';
import { requestAnalysis, ApiError } from '../api';

const getStoreSuggestions = (aesthetic: string) => {
  const stores: Record<string, { name: string; url: string; description: string }[]> = {
    streetwear: [
      { name: 'ASOS', url: 'https://asos.com', description: 'Trendy streetwear basics' },
      { name: 'Urban Outfitters', url: 'https://urbanoutfitters.com', description: 'Street and skate styles' },
      { name: 'Depop', url: 'https://depop.com', description: 'Thrifted streetwear finds' },
    ],
    vintage: [
      { name: 'Depop', url: 'https://depop.com', description: 'Curated vintage pieces' },
      { name: 'ThredUp', url: 'https://thredup.com', description: 'Secondhand vintage clothing' },
      { name: 'Etsy', url: 'https://etsy.com', description: 'Vintage and handmade fashion' },
    ],
    y2k: [
      { name: 'SHEIN', url: 'https://shein.com', description: 'Affordable Y2K inspired styles' },
      { name: 'Depop', url: 'https://depop.com', description: 'Authentic Y2K vintage finds' },
      { name: 'PrettyLittleThing', url: 'https://prettylittlething.com', description: 'Y2K trends' },
    ],
    minimalist: [
      { name: 'Everlane', url: 'https://everlane.com', description: 'Clean minimalist essentials' },
      { name: 'COS', url: 'https://cosstores.com', description: 'Modern minimalist design' },
      { name: 'Uniqlo', url: 'https://uniqlo.com', description: 'Quality basics and staples' },
    ],
    cottagecore: [
      { name: 'Free People', url: 'https://freepeople.com', description: 'Romantic cottagecore styles' },
      { name: 'Anthropologie', url: 'https://anthropologie.com', description: 'Whimsical feminine pieces' },
      { name: 'Etsy', url: 'https://etsy.com', description: 'Handmade cottagecore clothing' },
    ],
    preppy: [
      { name: 'Ralph Lauren', url: 'https://ralphlauren.com', description: 'Classic preppy staples' },
      { name: 'J.Crew', url: 'https://jcrew.com', description: 'Timeless preppy essentials' },
      { name: 'Brooks Brothers', url: 'https://brooksbrothers.com', description: 'Traditional preppy style' },
    ],
    western: [
      { name: 'Wrangler', url: 'https://wrangler.com', description: 'Authentic western wear' },
      { name: 'Boot Barn', url: 'https://bootbarn.com', description: 'Western boots and apparel' },
      { name: 'Sheplers', url: 'https://sheplers.com', description: 'Western lifestyle clothing' },
    ],
    alternative: [
      { name: 'Hot Topic', url: 'https://hottopic.com', description: 'Alternative and edgy styles' },
      { name: 'ASOS', url: 'https://asos.com', description: 'Wide range of alt aesthetics' },
      { name: 'Depop', url: 'https://depop.com', description: 'Unique alternative finds' },
    ],
    athleisure: [
      { name: 'Lululemon', url: 'https://lululemon.com', description: 'Premium athleisure wear' },
      { name: 'Nike', url: 'https://nike.com', description: 'Sport and lifestyle styles' },
      { name: 'Gymshark', url: 'https://gymshark.com', description: 'Fitness fashion forward' },
    ],
    'business casual': [
      { name: 'Banana Republic', url: 'https://bananarepublic.com', description: 'Polished business casual' },
      { name: 'Zara', url: 'https://zara.com', description: 'Modern office-ready styles' },
      { name: 'Express', url: 'https://express.com', description: 'Work and weekend styles' },
    ],
    'dark academia': [
      { name: 'ASOS', url: 'https://asos.com', description: 'Dark academia essentials' },
      { name: 'Depop', url: 'https://depop.com', description: 'Thrifted dark academia finds' },
      { name: 'Zara', url: 'https://zara.com', description: 'Structured outerwear' },
    ],
    gorpcore: [
      { name: 'REI', url: 'https://rei.com', description: 'Outdoor technical gear' },
      { name: 'Patagonia', url: 'https://patagonia.com', description: 'Sustainable outdoor wear' },
      { name: "Arc'teryx", url: 'https://arcteryx.com', description: 'Premium technical outerwear' },
    ],
  };

  return stores[aesthetic] || [
    { name: 'ASOS', url: 'https://asos.com', description: 'Wide variety of styles' },
    { name: 'Depop', url: 'https://depop.com', description: 'Unique secondhand finds' },
    { name: 'Zara', url: 'https://zara.com', description: 'Trendy fashion essentials' },
  ];
};

// Staged-reveal states for a just-published post:
// idle      — normal visit, everything renders statically
// waiting   — analysis in flight: shimmer where the palette will land
// animating — analysis arrived on this view: sections settle in staggered
// timeout   — took too long: honest copy, post fully usable, still listening
// failed    — pipeline reported failure: honest copy, no shimmer
type RevealState = 'idle' | 'waiting' | 'animating' | 'timeout' | 'failed';

// Phase 9: analysis is a durable background job, so the author can be told
// which stage their post is actually at rather than a single "analyzing"
// blur. Readable only by the post's author (see firestore.rules).
interface AnalysisJob {
  status?: 'queued' | 'processing' | 'complete' | 'failed';
  attempts?: number;
  lastErrorCode?: string | null;
}

// What the author is shown. Derived from the job document when one is
// readable, and from the post's own analysisStatus otherwise (a legacy post,
// or a job document that has not been created yet).
type AnalysisPhase =
  | 'none' | 'queued' | 'analyzing' | 'retrying' | 'stalled' | 'failed' | 'exhausted';

// A post whose analysis never even got queued (the fire-and-forget request
// from Upload failed, or it predates the job queue) sits at 'pending'
// forever. After this long we stop calling that "queued" and offer a retry.
const STALLED_AFTER_MS = 5 * 60 * 1000;

export default function PostDetail() {
  const { postId } = useParams<{ postId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const justPublished = Boolean((location.state as { justPublished?: boolean } | null)?.justPublished);
  const [reveal, setReveal] = useState<RevealState>(justPublished ? 'waiting' : 'idle');
  // Animate only when THIS view watched the post go unanalyzed → analyzed.
  // history state survives reloads, so justPublished alone would replay the
  // animation on a refresh of an already-analyzed post.
  const sawUnanalyzedRef = useRef(false);
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [authorEmail, setAuthorEmail] = useState('');
  const [authorUsername, setAuthorUsername] = useState('');
  const [authorPhotoURL, setAuthorPhotoURL] = useState('');
  const uid = auth.currentUser?.uid || '';

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // FIX 2: photo zoom state
  const [zoomedImage, setZoomedImage] = useState(false);

  const aesthetic = post?.aesthetic;
  const storeSuggestions = useMemo(
    () => (aesthetic ? getStoreSuggestions(aesthetic) : []),
    [aesthetic]
  );

  // FIX 10: likers modal state
  const [showLikers, setShowLikers] = useState(false);
  const [likerEmails, setLikerEmails] = useState<string[]>([]);
  const [loadingLikers, setLoadingLikers] = useState(false);

  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [jobLoaded, setJobLoaded] = useState(false);
  // Read once at mount: the render pass stays pure, and "has this been
  // pending too long" does not flip mid-render.
  const [mountedAt] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState('');
  // Phase 8: the viewer's like is their own document under the post, so it
  // is read once here rather than inferred from a field on the post.
  const [liked, setLiked] = useState(false);

  useEffect(() => {
    if (!postId) return;

    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });

    // Live listener (not a one-shot get): a just-published post's analysis
    // fields stream in through the same snapshot flow the feed uses.
    const guard = setTimeout(() => setLoading(false), 6000);
    const unsubscribe = onSnapshot(doc(db, 'posts', postId), (snap) => {
      clearTimeout(guard);
      if (!snap.exists()) {
        setPost(null);
        setLoading(false);
        return;
      }
      const data = {
        id: snap.id,
        ...snap.data(),
        createdAt: snap.data().createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
      } as Post;
      setPost(data);
      setLoading(false);
      // Reveal transitions only apply to the just-published flow
      if (!data.analyzed) sawUnanalyzedRef.current = true;
      setReveal(prev => {
        if (prev === 'idle' || prev === 'animating' || prev === 'failed') return prev;
        // Already analyzed before we ever saw it pending (e.g. a reload
        // after analysis finished): compose statically, no replay.
        if (data.analyzed) return sawUnanalyzedRef.current ? 'animating' : 'idle';
        if (data.analysisStatus === 'failed') return 'failed';
        return prev;
      });
    }, (error) => {
      console.error('[PostDetail] Snapshot error:', error);
      clearTimeout(guard);
      setLoading(false);
    });

    getComments(postId).then(setComments);

    return () => {
      unsubscribe();
      clearTimeout(guard);
    };
  }, [postId]);

  // Honest wait: if analysis hasn't landed after 30s, stop shimmering and
  // say so — the listener stays attached, so a late arrival still reveals.
  useEffect(() => {
    if (reveal !== 'waiting') return;
    const t = setTimeout(() => {
      setReveal(prev => (prev === 'waiting' ? 'timeout' : prev));
    }, 30000);
    return () => clearTimeout(t);
  }, [reveal]);

  // Author + saved lookups are one-shot; run once the author is known
  const authorId = post?.authorId;
  useEffect(() => {
    if (!authorId) return;
    getPublicProfile(authorId).then(profile => {
      setAuthorEmail(displayHandle(profile ?? undefined, authorId));
      setAuthorUsername(profile?.username ?? '');
      setAuthorPhotoURL(profile?.photoURL ?? '');
    }).catch(() => setAuthorEmail(`user_${authorId.slice(0, 6)}`));
  }, [authorId]);

  useEffect(() => {
    if (!uid || !postId) return;
    isPostSaved(uid, postId).then(setSaved);
    hasLiked(postId, uid).then(setLiked);
  }, [uid, postId]);

  // The analysis job is readable only by the post's author, and only they
  // can act on it - so nobody else pays for the listener either.
  const isAuthor = Boolean(uid && post?.authorId === uid);
  useEffect(() => {
    if (!postId || !isAuthor || post?.analyzed) return;
    const unsubscribe = onSnapshot(
      doc(db, 'analysisJobs', postId),
      (snap) => {
        setJob(snap.exists() ? (snap.data() as AnalysisJob) : null);
        setJobLoaded(true);
      },
      // A missing job document is normal (legacy posts); a denied read is
      // not worth surfacing - the post itself still tells the story.
      () => { setJob(null); setJobLoaded(true); }
    );
    return unsubscribe;
  }, [postId, isAuthor, post?.analyzed]);

  const analysisPhase: AnalysisPhase = (() => {
    if (!post || post.analyzed) return 'none';
    if (job?.status === 'failed') return 'exhausted';
    if (job?.status === 'processing') return 'analyzing';
    if (job?.status === 'queued') return (job.attempts ?? 0) > 0 ? 'retrying' : 'queued';
    // No readable job: fall back to what the post itself records.
    if (post.analysisStatus === 'processing') return 'analyzing';
    if (post.analysisStatus === 'failed') return 'failed';
    if (post.analysisStatus === 'pending') {
      const age = mountedAt - new Date(post.createdAt).getTime();
      if (jobLoaded && !job && age > STALLED_AFTER_MS) return 'stalled';
      return 'queued';
    }
    return 'none';
  })();

  const handleRetryAnalysis = async () => {
    if (!postId || retrying) return;
    setRetrying(true);
    setRetryNote('');
    try {
      const result = await requestAnalysis(postId);
      if (result.status === 'failed') {
        // Attempts are a spend budget: an exhausted post is re-armed by an
        // operator, not by pressing a button repeatedly.
        setRetryNote('This fit has used all its analysis attempts. Support can reset it.');
        setRetrying(false);
        return;
      }
      if (result.status === 'already_complete') {
        setRetryNote('');
        setRetrying(false);
        return;
      }
      setReveal(prev => (prev === 'failed' || prev === 'timeout' ? 'waiting' : prev));
      setRetrying(false);
    } catch (error) {
      const message = error instanceof ApiError && error.status === 429
        ? 'Too many requests just now - give it a minute and try again.'
        : 'Could not reach the analyzer. Try again in a moment.';
      setRetryNote(message);
      setRetrying(false);
    }
  };

  const handleLike = async () => {
    if (!post || !uid) return;
    const wasLiked = liked;
    setLiked(!wasLiked);
    setPost(prev => prev ? {
      ...prev,
      likesCount: wasLiked ? (prev.likesCount || 1) - 1 : (prev.likesCount || 0) + 1,
    } : null);
    const didLike = await toggleLike(post.id, uid);
    setLiked(didLike);
    if (didLike && post.category) {
      await recordInteraction(uid, post.category, 'like');
    }
  };

  const handleToggleSave = async () => {
    if (!post || !uid || saving) return;
    const wasSaved = saved;
    setSaved(!wasSaved);
    setSaving(true);
    if (wasSaved) {
      await unsavePost(uid, post.id);
    } else {
      await savePost(uid, post.id);
    }
    setSaving(false);
  };

  const handleAddComment = async () => {
    if (!post || !newComment.trim() || !uid) return;
    const email = auth.currentUser?.email || 'anonymous';
    const success = await addComment(post.id, uid, email, newComment);
    if (success) {
      setNewComment('');
      const updated = await getComments(post.id);
      setComments(updated);
      setPost(prev => prev ? { ...prev, commentsCount: (prev.commentsCount || 0) + 1 } : null);
      if (post.category) await recordInteraction(uid, post.category, 'comment');
    }
  };

  const handleDelete = async () => {
    if (!post || !uid) return;
    setDeleting(true);
    const success = await deletePost(post.id, uid);
    if (success) {
      navigate('/', { replace: true });
    } else {
      setDeleting(false);
      setShowDeleteConfirm(false);
      alert('Failed to delete post. Please try again.');
    }
  };

  // FIX 10: show who liked
  const handleShowLikers = async () => {
    if (!post || !post.likesCount) return;
    setLoadingLikers(true);
    setShowLikers(true);
    // Bounded query over the likes subcollection, then one batched read of
    // public handles instead of a serial read per liker.
    const likerIds = await getLikerIds(post.id, 20);
    const profiles = await getPublicProfiles(likerIds);
    setLikerEmails(likerIds.map(id => `@${displayHandle(profiles[id], id)}`));
    setLoadingLikers(false);
  };

  // Staged reveal: extra class + per-section delay, only while animating a
  // live arrival. Idle/revisit renders get empty values — zero motion.
  const revealing = reveal === 'animating';
  const revealCls = revealing ? ' reveal-item' : '';
  const revealDelay = (i: number): React.CSSProperties | undefined =>
    revealing ? ({ '--d': `${i * 0.25}s` } as React.CSSProperties) : undefined;

  if (loading) return (
    <div className="max-w-lg mx-auto pb-24 animate-pulse">
      <div className="w-full aspect-square bg-[var(--border)]" />
      <div className="p-4 flex flex-col gap-3">
        <div className="h-4 bg-[var(--border)] rounded w-1/3" />
        <div className="h-6 bg-[var(--border)] rounded w-2/3" />
        <div className="flex gap-2">
          <div className="h-16 bg-[var(--border)] rounded-xl flex-1" />
          <div className="h-16 bg-[var(--border)] rounded-xl flex-1" />
          <div className="h-16 bg-[var(--border)] rounded-xl flex-1" />
        </div>
        <div className="h-4 bg-[var(--border)] rounded w-full" />
        <div className="h-4 bg-[var(--border)] rounded w-4/5" />
      </div>
    </div>
  );

  if (!post) return (
    <div className="max-w-lg mx-auto pt-24">
      <EmptyState
        title="This fit is gone"
        message="The post may have been deleted, or the link is off."
        action={{ label: 'Back to the feed', onClick: () => navigate('/') }}
      />
    </div>
  );

  return (
    <div className="max-w-lg mx-auto pb-24">
      {/* Back button */}
      <div className="p-4">
        <button onClick={() => navigate(-1)} className="text-[var(--text)] text-sm flex items-center gap-1">
          ← Back
        </button>
      </div>

      {/* Full image — FIX 2: tappable zoom, FIX 14: no Aura badge */}
      {post.imageUrl && (
        <div
          className="relative cursor-zoom-in"
          onClick={() => setZoomedImage(true)}
        >
          <PostImage src={post.imageUrl} alt="outfit" className="w-full min-h-40 object-cover" />
        </div>
      )}

      {/* FIX 2: Zoom modal */}
      {zoomedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-4"
          onClick={() => setZoomedImage(false)}
        >
          <img
            src={post.imageUrl}
            alt="outfit zoomed"
            className="max-w-full max-h-full object-contain rounded-lg"
          />
          <button
            className="absolute top-4 right-4 text-white text-2xl bg-black/50 rounded-full w-10 h-10 flex items-center justify-center"
            onClick={() => setZoomedImage(false)}
          >
            ×
          </button>
        </div>
      )}

      <div className="p-4">
        {/* Author and actions */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => navigate(`/profile/${post.authorId}`)}
            className="flex items-center gap-2"
          >
            <div className="w-8 h-8 rounded-full bg-[var(--border)] flex items-center justify-center text-xs overflow-hidden shrink-0">
              {authorPhotoURL
                ? <img src={authorPhotoURL} alt="avatar" className="w-full h-full object-cover" loading="lazy" decoding="async" />
                : '👤'}
            </div>
            <span className="text-sm font-medium text-[var(--text-h)]">{formatAuthor(authorEmail, authorUsername)}</span>
          </button>
          {/* FIX 10: like button shows likers modal on count tap */}
          <div className="flex items-center gap-2">
            {uid === post.authorId && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="text-xs border border-red-300 text-red-500 rounded-full px-3 py-1 hover:bg-red-50 transition cursor-pointer"
              >
                Delete
              </button>
            )}
            <button
              onClick={handleLike}
              className="flex items-center gap-1 text-sm"
            >
              {liked ? '❤️' : '🤍'}
            </button>
            <button
              onClick={handleShowLikers}
              className="text-sm text-[var(--text)] hover:text-[var(--accent)] transition"
            >
              {post.likesCount || 0} {post.likesCount === 1 ? 'like' : 'likes'}
            </button>
            <button
              onClick={handleToggleSave}
              disabled={saving}
              aria-label={saved ? 'Unsave' : 'Save'}
              className={`p-1 -mr-1 disabled:opacity-50 ${saved ? 'text-[var(--accent)]' : 'text-[var(--text)] hover:text-[var(--accent)]'} transition`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill={saved ? 'currentColor' : 'none'}
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
                className="size-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Date */}
        {post.createdAt && (
          <p className="text-xs uppercase tracking-wide text-[var(--text)] mb-2">
            {new Date(post.createdAt).toLocaleDateString('en-US', {
              month: 'long', day: 'numeric', year: 'numeric',
            })}
          </p>
        )}

        {/* Outfit name as hero title — keyed so a live arrival fades the
            caption into the studio-given name instead of hard-swapping */}
        <h1
          key={post.outfitName ? 'named' : 'caption'}
          className={`text-xl font-bold text-[var(--text-h)] mb-2${post.outfitName ? revealCls : ''}`}
          style={post.outfitName ? revealDelay(1) : undefined}
        >
          {post.outfitName || post.content}
        </h1>
        {post.outfitName && post.content && (
          <p className={`text-sm text-[var(--text)] mb-3${revealCls}`} style={revealDelay(1)}>{post.content}</p>
        )}

        {/* Outfit breakdown */}
        {post.outfitBreakdown && (
          <p className="text-sm text-[var(--text)] mb-4">{post.outfitBreakdown}</p>
        )}

        {/* Live analysis wait — occupies the palette's slot so the real
            cards land without layout shift. Honest states, never an
            infinite shimmer. */}
        {reveal === 'waiting' && !post.analyzed && (
          <div className="mb-4">
            <div className="flex items-center gap-1.5 mb-3">
              <div className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
              <span className="text-xs text-[var(--text)] opacity-60">
                Reading this fit — palette and aesthetics on the way
              </span>
            </div>
            <div className="flex gap-2 animate-pulse" aria-hidden="true">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex-1 rounded-xl bg-[var(--border)] opacity-60" style={{ minHeight: '80px' }} />
              ))}
            </div>
          </div>
        )}
        {reveal === 'timeout' && !post.analyzed && (
          <div className="border border-[var(--border)] rounded-xl p-4 mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
              Still reading
            </p>
            <p className="text-sm text-[var(--text)] leading-relaxed">
              This one's taking longer than usual. Your fit is live — the palette and aesthetics will appear here once the reading lands.
            </p>
          </div>
        )}
        {reveal === 'failed' && !post.analyzed && !isAuthor && (
          <div className="border border-[var(--border)] rounded-xl p-4 mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
              No reading this time
            </p>
            <p className="text-sm text-[var(--text)] leading-relaxed">
              The analysis didn't come through for this fit. It's live everywhere it should be — the palette and aesthetics just won't show here.
            </p>
          </div>
        )}

        {/* Analysis lifecycle — author only. Analysis runs as a durable
            background job, so closing the tab does not cancel it and the
            author is told which stage it is actually at rather than a single
            indefinite "analyzing". */}
        {isAuthor && analysisPhase !== 'none' && reveal !== 'waiting' && (
          <div
            className="border border-[var(--border)] rounded-xl p-4 mb-4"
            role="status"
            aria-live="polite"
            data-testid="analysis-status"
          >
            {analysisPhase === 'queued' && (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
                  Queued
                </p>
                <p className="text-sm text-[var(--text)] leading-relaxed">
                  Your fit is in line to be read. This runs on our side — you can close the app and it'll still finish.
                </p>
              </>
            )}
            {analysisPhase === 'analyzing' && (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
                  Analyzing
                </p>
                <p className="text-sm text-[var(--text)] leading-relaxed">
                  Reading this fit now — the palette and aesthetics will land here on their own.
                </p>
              </>
            )}
            {analysisPhase === 'retrying' && (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
                  Trying again
                </p>
                <p className="text-sm text-[var(--text)] leading-relaxed">
                  The first read didn't go through, so it's queued for another attempt
                  {typeof job?.attempts === 'number' ? ` (attempt ${job.attempts + 1} of 3)` : ''}.
                </p>
              </>
            )}
            {analysisPhase === 'stalled' && (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
                  Analysis never started
                </p>
                <p className="text-sm text-[var(--text)] leading-relaxed mb-3">
                  This fit never made it into the queue. Your post is live — you can ask for the reading now.
                </p>
                <button
                  onClick={handleRetryAnalysis}
                  disabled={retrying}
                  className="text-xs border border-[var(--border)] rounded-full px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)] transition disabled:opacity-50 cursor-pointer"
                >
                  {retrying ? 'Sending…' : 'Analyze this fit'}
                </button>
              </>
            )}
            {analysisPhase === 'failed' && (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
                  Analysis didn't finish
                </p>
                <p className="text-sm text-[var(--text)] leading-relaxed mb-3">
                  Your fit is live everywhere it should be — the palette and aesthetics just didn't come through.
                </p>
                <button
                  onClick={handleRetryAnalysis}
                  disabled={retrying}
                  className="text-xs border border-[var(--border)] rounded-full px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)] transition disabled:opacity-50 cursor-pointer"
                >
                  {retrying ? 'Sending…' : 'Try analysis again'}
                </button>
              </>
            )}
            {analysisPhase === 'exhausted' && (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
                  Analysis unavailable for this fit
                </p>
                <p className="text-sm text-[var(--text)] leading-relaxed">
                  We tried a few times and it didn't work out. The post is fine and fully live — it just won't have a palette or aesthetic tags.
                </p>
              </>
            )}
            {retryNote && (
              <p className="text-xs text-[var(--text)] opacity-70 mt-2">{retryNote}</p>
            )}
          </div>
        )}

        {/* FIX 7: Aesthetic / category badge clickable */}
        {post.aesthetic && (
          <div className={`mb-3${revealCls}`} style={revealDelay(2)}>
            <button
              onClick={() => navigate(`/explore?category=${encodeURIComponent(post.aesthetic!)}`)}
              className="text-xs bg-[var(--accent)] text-white rounded-full px-3 py-1 capitalize hover:opacity-80 transition"
            >
              {post.aesthetic}
            </button>
          </div>
        )}

        {/* Color Palette Cards — FIX 9: clickable */}
        {post.palette && post.palette.length > 0 && (
          <div className={`flex gap-2 mb-4${revealCls}`} style={revealDelay(0)}>
            {post.palette.map((color, i) => {
              const c = normalizeColor(color);
              const textColor = isLightColor(c.hex) ? '#000000' : '#ffffff';
              return (
                <div
                  key={i}
                  onClick={() => navigate(`/explore?color=${encodeURIComponent(c.name)}`)}
                  className="flex-1 rounded-xl overflow-hidden cursor-pointer hover:opacity-90 transition active:scale-95"
                  style={{ backgroundColor: c.hex, minHeight: '80px' }}
                >
                  <div className="flex flex-col justify-between p-3 min-h-[80px]">
                    {c.percentage !== null && (
                      <span className="text-sm font-bold" style={{ color: textColor }}>
                        {c.percentage}%
                      </span>
                    )}
                    <div>
                      <p className="text-xs font-semibold leading-tight" style={{ color: textColor }}>
                        {c.name}
                      </p>
                      <p className="text-xs opacity-60" style={{ color: textColor }}>
                        {c.hex}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* FIX 13: Compact aesthetic composition chips */}
        {post.aestheticScores && Object.keys(post.aestheticScores).length > 0 && (
          <div className={`mb-4${revealCls}`} style={revealDelay(2)}>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-2">
              Aesthetic Composition
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(post.aestheticScores)
                .filter(([, score]) => score > 0.2)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([label, score]) => (
                  <button
                    key={label}
                    onClick={() => navigate(`/explore?category=${encodeURIComponent(label)}`)}
                    className="flex items-center gap-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-full px-2.5 py-1 hover:border-[var(--accent)] transition"
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: score > 0.6 ? '#2d5a27' : score > 0.4 ? '#4a7c42' : '#8a9e85'
                      }}
                    />
                    <span className="text-xs text-[var(--text-h)] capitalize">{label}</span>
                    <span className="text-xs text-[var(--text)] opacity-60">{Math.round(score * 100)}%</span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Notes on Composition */}
        {post.styleNotes && (
          <div className={`border border-[var(--border)] rounded-xl p-4 mb-4${revealCls}`} style={revealDelay(3)}>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-2">
              Notes on Composition
            </p>
            <p className="text-sm text-[var(--text)] leading-relaxed">{post.styleNotes}</p>
          </div>
        )}

        {/* FIX 7: Aesthetic tags — clickable */}
        {post.aestheticTags && post.aestheticTags.length > 0 && (
          <div className={`flex gap-2 flex-wrap mb-4${revealCls}`} style={revealDelay(3)}>
            {post.aestheticTags.map((tag, i) => (
              <button
                key={i}
                onClick={() => navigate(`/explore?tag=${encodeURIComponent(tag)}`)}
                className="border border-[var(--border)] rounded-full px-3 py-1 text-xs text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Detected items */}
        {post.detectedItems && post.detectedItems.length > 0 && (
          <div className={`mb-4${revealCls}`} style={revealDelay(3)}>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-2">
              Detected Items
            </p>
            <p className="text-sm text-[var(--text)]">{post.detectedItems.join(' · ')}</p>
          </div>
        )}

        {/* Style description */}
        {post.styleDescription && (
          <p className={`text-sm italic text-[var(--text)] mb-4${revealCls}`} style={revealDelay(3)}>{post.styleDescription}</p>
        )}

        {/* Shop Similar */}
        {post.detectedItems && post.detectedItems.length > 0 && post.aesthetic && (
          <div className={`border border-[var(--border)] rounded-xl p-4 mb-4${revealCls}`} style={revealDelay(3)}>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-3">
              Shop Similar
            </p>
            <div className="flex flex-col gap-2">
              {storeSuggestions.map((store, i) => (
                <a
                  key={i}
                  href={store.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between p-3 border border-[var(--border)] rounded-lg hover:border-[var(--accent)] transition"
                >
                  <div>
                    <p className="text-sm font-medium text-[var(--text-h)]">{store.name}</p>
                    <p className="text-xs text-[var(--text)]">{store.description}</p>
                  </div>
                  <span className="text-[var(--text)] text-sm">→</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Comments */}
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-3">
            Comments ({post.commentsCount || 0})
          </p>
          <div className="flex flex-col gap-3 mb-4">
            {comments.length === 0 && (
              <p className="text-xs text-[var(--text)] opacity-60">No comments yet. Be first!</p>
            )}
            {comments.map(comment => (
              <div key={comment.id} className="flex gap-2">
                <div className="w-6 h-6 rounded-full bg-[var(--border)] flex items-center justify-center text-xs shrink-0">
                  👤
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-h)]">{comment.authorEmail}</p>
                  <p className="text-sm text-[var(--text)]">{comment.content}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Add a comment..."
              value={newComment}
              onChange={e => setNewComment(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddComment()}
              className="flex-1 border border-[var(--border)] rounded-full px-4 py-2 text-sm bg-[var(--bg)] text-[var(--text-h)]"
            />
            <button
              onClick={handleAddComment}
              disabled={!newComment.trim()}
              className="bg-[var(--accent)] text-white rounded-full px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              Post
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="bg-[var(--bg)] rounded-2xl w-full max-w-sm p-6"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-[var(--text-h)] mb-2">Delete Post?</h3>
            <p className="text-sm text-[var(--text)] mb-6">
              This will permanently delete your post, its comments, and the image. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="flex-1 border border-[var(--border)] rounded-xl py-3 text-sm text-[var(--text)] cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 bg-red-500 text-white rounded-xl py-3 text-sm font-medium cursor-pointer disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FIX 10: Likers modal */}
      {showLikers && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center"
          onClick={() => setShowLikers(false)}
        >
          <div
            className="bg-[var(--bg)] rounded-t-2xl w-full max-w-lg p-6 max-h-96 overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-[var(--text-h)] mb-4">
              Liked by {post.likesCount || 0}
            </h3>
            {loadingLikers ? (
              <p className="text-sm text-[var(--text)] animate-pulse">Loading...</p>
            ) : likerEmails.length === 0 ? (
              <p className="text-sm text-[var(--text)]">No likes yet</p>
            ) : (
              <div className="flex flex-col gap-3">
                {likerEmails.map((email, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center text-sm">
                      👤
                    </div>
                    <p className="text-sm text-[var(--text-h)]">{email}</p>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => setShowLikers(false)}
              className="w-full mt-4 border border-[var(--border)] rounded-xl py-3 text-sm text-[var(--text)]"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
