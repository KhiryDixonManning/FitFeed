import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db, auth } from '../../firebase';
import { type Post, toggleLike, getComments, addComment, type Comment } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import { formatAuthor } from '../utils/formatAuthor';

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
      { name: 'Arc\'teryx', url: 'https://arcteryx.com', description: 'Premium technical outerwear' },
    ],
  };

  return stores[aesthetic] || [
    { name: 'ASOS', url: 'https://asos.com', description: 'Wide variety of styles' },
    { name: 'Depop', url: 'https://depop.com', description: 'Unique secondhand finds' },
    { name: 'Zara', url: 'https://zara.com', description: 'Trendy fashion essentials' },
  ];
};

const hexToReadableName = (hex: string): string => {
  if (!hex) return 'Unknown';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  if (r > 200 && g < 100 && b < 100) return 'Red';
  if (r < 100 && g > 150 && b < 100) return 'Green';
  if (r < 100 && g < 100 && b > 200) return 'Blue';
  if (r > 200 && g > 150 && b < 100) return 'Orange';
  if (r > 200 && g > 200 && b < 100) return 'Yellow';
  if (r > 150 && g < 100 && b > 150) return 'Purple';
  if (r > 180 && g < 120 && b > 120) return 'Rose';
  if (r > 150 && g > 100 && b < 80) return 'Camel';
  if (r < 80 && g < 80 && b < 80) return 'Black';
  if (brightness > 220) return 'White';
  if (brightness > 180) return 'Cream';
  if (brightness > 150) return 'Light Gray';
  if (brightness > 100) return 'Gray';
  if (brightness > 50) return 'Charcoal';
  return 'Dark';
};

const normalizeColor = (color: any): { hex: string; name: string; percentage: number | null } => {
  if (typeof color === 'string') {
    return {
      hex: color,
      name: hexToReadableName(color),
      percentage: null,
    };
  }
  return {
    hex: color.hex || '#000000',
    name: color.name || hexToReadableName(color.hex) || 'Unknown',
    percentage: color.percentage ?? null,
  };
};

export default function PostDetail() {
  const { postId } = useParams<{ postId: string }>();
  const navigate = useNavigate();
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [authorEmail, setAuthorEmail] = useState('');
  const [authorUsername, setAuthorUsername] = useState('');
  const uid = auth.currentUser?.uid || '';

  useEffect(() => {
    if (!postId) return;
    const load = async () => {
      const postDoc = await getDoc(doc(db, 'posts', postId));
      if (postDoc.exists()) {
        const data = {
          id: postDoc.id,
          ...postDoc.data(),
          createdAt: postDoc.data().createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
        } as Post;
        setPost(data);

        const userDoc = await getDoc(doc(db, 'users', data.authorId));
        if (userDoc.exists()) {
          const userData = userDoc.data();
          setAuthorEmail(userData.email || data.authorId);
          setAuthorUsername(userData.username || '');
        } else {
          setAuthorEmail(`user_${data.authorId.slice(0, 6)}`);
        }

        const fetchedComments = await getComments(postId);
        setComments(fetchedComments);
      }
      setLoading(false);
    };
    load();
  }, [postId]);

  const handleLike = async () => {
    if (!post || !uid) return;
    const wasLiked = post.likedBy?.includes(uid);
    setPost(prev => prev ? {
      ...prev,
      likesCount: wasLiked ? (prev.likesCount || 1) - 1 : (prev.likesCount || 0) + 1,
      likedBy: wasLiked
        ? prev.likedBy?.filter(id => id !== uid)
        : [...(prev.likedBy || []), uid],
    } : null);
    const didLike = await toggleLike(post.id, uid);
    if (didLike && post.category) {
      await recordInteraction(uid, post.category, 'like');
    }
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

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-[var(--text)] animate-pulse">Loading...</p>
    </div>
  );

  if (!post) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-[var(--text)]">Post not found.</p>
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

      {/* Full image */}
      {post.imageUrl && (
        <div className="relative">
          <img src={post.imageUrl} alt="outfit" className="w-full object-cover" />
          {/* Aura badge */}
          <div className="absolute top-3 right-3 bg-black/80 backdrop-blur-sm rounded-full px-3 py-1 flex items-center gap-1">
            <span className="text-white text-sm">◎</span>
            <span className="text-white text-sm font-semibold">
              {(post.likesCount || 0) + (post.commentsCount || 0)}
            </span>
          </div>
        </div>
      )}

      <div className="p-4">
        {/* Author and actions */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => navigate(`/profile/${post.authorId}`)}
            className="flex items-center gap-2"
          >
            <div className="w-8 h-8 rounded-full bg-[var(--border)] flex items-center justify-center text-xs">
              👤
            </div>
            <span className="text-sm font-medium text-[var(--text-h)]">{formatAuthor(authorEmail, authorUsername)}</span>
          </button>
          <button
            onClick={handleLike}
            className="flex items-center gap-1 text-sm"
          >
            {post.likedBy?.includes(uid) ? '❤️' : '🤍'} {post.likesCount || 0}
          </button>
        </div>

        {/* Date */}
        {post.createdAt && (
          <p className="text-xs uppercase tracking-wide text-[var(--text)] mb-2">
            {new Date(post.createdAt).toLocaleDateString('en-US', {
              month: 'long', day: 'numeric', year: 'numeric',
            })}
          </p>
        )}

        {/* Caption */}
        {post.content && (
          <h1 className="text-xl font-bold text-[var(--text-h)] mb-2">{post.content}</h1>
        )}

        {/* Outfit breakdown */}
        {post.outfitBreakdown && (
          <p className="text-sm text-[var(--text)] mb-4">{post.outfitBreakdown}</p>
        )}

        {/* Color Palette Cards */}
        {post.palette && post.palette.length > 0 && (
          <div className="flex gap-2 mb-4">
            {post.palette.map((color, i) => {
              const c = normalizeColor(color);
              const isLight = c.hex === '#FFFFFF' || c.hex === '#ffffff' ||
                (parseInt(c.hex.slice(1, 3), 16) > 200 &&
                 parseInt(c.hex.slice(3, 5), 16) > 200 &&
                 parseInt(c.hex.slice(5, 7), 16) > 200);
              const textColor = isLight ? '#000000' : '#ffffff';
              return (
                <div
                  key={i}
                  className="flex-1 rounded-xl overflow-hidden"
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

        {/* Aesthetic Composition */}
        {post.aestheticScores && Object.keys(post.aestheticScores).length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">
              Aesthetic Composition
            </p>
            <p className="text-xs text-[var(--text)] opacity-60 mb-3">(subjective; contextual)</p>
            <div className="flex flex-col gap-3">
              {Object.entries(post.aestheticScores)
                .filter(([, score]) => score > 0.1)
                .sort((a, b) => b[1] - a[1])
                .map(([label, score]) => (
                  <div key={label} className="flex items-center gap-3">
                    <span className="text-sm text-[var(--text-h)] capitalize w-28 shrink-0">{label}</span>
                    <div className="flex-1 h-2 bg-[var(--border)] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${Math.round(score * 100)}%`,
                          backgroundColor: score > 0.5 ? '#2d5a27' : score > 0.3 ? '#4a7c42' : '#8a9e85',
                        }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Notes on Composition */}
        {post.styleNotes && (
          <div className="border border-[var(--border)] rounded-xl p-4 mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-2">
              Notes on Composition
            </p>
            <p className="text-sm text-[var(--text)] leading-relaxed">{post.styleNotes}</p>
          </div>
        )}

        {/* Style tags */}
        {post.aestheticTags && post.aestheticTags.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-4">
            {post.aestheticTags.map((tag, i) => (
              <span key={i} className="border border-[var(--border)] rounded-full px-3 py-1 text-xs text-[var(--text)]">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Detected items */}
        {post.detectedItems && post.detectedItems.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-2">
              Detected Items
            </p>
            <p className="text-sm text-[var(--text)]">{post.detectedItems.join(' · ')}</p>
          </div>
        )}

        {/* Style description */}
        {post.styleDescription && (
          <p className="text-sm italic text-[var(--text)] mb-4">{post.styleDescription}</p>
        )}

        {/* Shop Similar */}
        {post.detectedItems && post.detectedItems.length > 0 && post.aesthetic && (
          <div className="border border-[var(--border)] rounded-xl p-4 mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-3">
              Shop Similar
            </p>
            <div className="flex flex-col gap-2">
              {getStoreSuggestions(post.aesthetic).map((store, i) => (
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
    </div>
  );
}
