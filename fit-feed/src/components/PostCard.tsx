import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../../firebase';
import { addComment, getComments, type Comment, type Post } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import ProfileAvatar from './ProfileAvatar';

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

interface PostCardProps {
  post: Post;
  uid: string;
  authorEmail: string;
  isLiked: boolean;
  onLike: () => void;
  liking: boolean;
  onCommentAdded: (postId: string) => void;
}

export default function PostCard({
  post,
  uid,
  authorEmail,
  isLiked,
  onLike,
  liking,
  onCommentAdded,
}: PostCardProps) {
  const navigate = useNavigate();
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loadingComments, setLoadingComments] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleToggleComments = async () => {
    const next = !showComments;
    setShowComments(next);
    if (next && comments.length === 0) {
      setLoadingComments(true);
      const fetched = await getComments(post.id);
      setComments(fetched);
      setLoadingComments(false);
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    setSubmitting(true);
    const email = auth.currentUser?.email ?? 'anonymous';
    const success = await addComment(post.id, uid, email, newComment);
    if (success) {
      setNewComment('');
      if (post.category) {
        await recordInteraction(uid, post.category, 'comment');
      }
      const updated = await getComments(post.id);
      setComments(updated);
      onCommentAdded(post.id);
    }
    setSubmitting(false);
  };

  return (
    <div className="rounded-2xl shadow-lg bg-[var(--bg-secondary)] overflow-hidden flex flex-col">
      {/* Image — tapping navigates to post detail */}
      <div
        className="overflow-hidden cursor-pointer bg-gray-100 relative"
        onClick={() => navigate(`/post/${post.id}`)}
      >
        {post.imageUrl ? (
          <img
            src={post.imageUrl}
            alt={post.content ?? 'outfit'}
            className="w-full aspect-square object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full aspect-square flex items-center justify-center text-gray-400 text-sm">
            No image
          </div>
        )}
        {/* Aura Score Badge */}
        <div className="absolute top-2 right-2 bg-black/80 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
          <span className="text-white text-xs">◎</span>
          <span className="text-white text-xs font-semibold">
            {(post.likesCount || 0) + (post.commentsCount || 0)}
          </span>
        </div>
        {/* Category badge bottom left */}
        {post.category && (
          <div className="absolute bottom-2 left-2">
            <span className="bg-black/70 backdrop-blur-sm text-white text-xs rounded-full px-2 py-1 capitalize">
              {post.category}
            </span>
          </div>
        )}
      </div>

      {/* Author info */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <button
          onClick={() => navigate(`/profile/${post.authorId}`)}
          className="shrink-0 hover:opacity-80 transition"
        >
          <ProfileAvatar size={36} />
        </button>
        <div className="flex-1 min-w-0">
          {post.content && (
            <p className="font-semibold text-gray-900 text-sm leading-tight truncate">{post.content}</p>
          )}
          <p className="text-gray-500 text-xs truncate">@{authorEmail}</p>
        </div>
      </div>

      {/* Category + outfit breakdown */}
      {(post.category || post.outfitBreakdown) && (
        <div className="px-3 pt-2 flex flex-col gap-1">
          {post.category && (
            <span className="text-xs bg-[var(--accent)] text-white rounded-full px-2 py-0.5 w-fit capitalize">
              {post.category}
            </span>
          )}
          {post.outfitBreakdown && (
            <p className="text-xs text-gray-500 leading-relaxed">{post.outfitBreakdown}</p>
          )}
        </div>
      )}

      {/* Analyzing indicator — shows while analysis is pending */}
      {!post.analyzed && !post.palette?.length && (
        <div className="flex items-center gap-1 px-3 mt-2">
          <div className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
          <span className="text-xs text-[var(--text)] opacity-60">Analyzing outfit...</span>
        </div>
      )}

      {/* Color Palette Cards */}
      {post.palette && post.palette.length > 0 && (
        <div className="flex gap-2 mt-3">
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
                style={{ backgroundColor: c.hex, minHeight: '72px' }}
              >
                <div className="flex flex-col justify-between p-2 min-h-[72px]">
                  {c.percentage !== null && (
                    <span className="text-xs font-semibold" style={{ color: textColor }}>
                      {c.percentage}%
                    </span>
                  )}
                  <div>
                    <p className="text-xs font-medium leading-tight" style={{ color: textColor }}>
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

      {/* Full analysis results */}
      {post.analyzed === true && (
        <div className="px-3 pt-1 flex flex-col gap-1">
          {post.aestheticTags && post.aestheticTags.length > 0 && (
            <div className="flex gap-1 flex-wrap mt-1">
              {post.aestheticTags.map((tag, i) => (
                <span
                  key={i}
                  className="text-xs border border-[var(--border)] rounded-full px-2 py-0.5 text-[var(--text)]"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {post.detectedItems && post.detectedItems.length > 0 && (
            <p className="text-xs text-[var(--text)] mt-1">
              {post.detectedItems.join(' · ')}
            </p>
          )}
          {post.styleDescription && (
            <p className="text-xs italic text-[var(--text)] mt-1">
              {post.styleDescription}
            </p>
          )}
          {post.aestheticScores && Object.keys(post.aestheticScores).length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {Object.entries(post.aestheticScores)
                .filter(([, score]) => score > 0.3)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([label, score]) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-xs text-[var(--text)] w-24 capitalize">{label}</span>
                    <div className="flex-1 h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent)] rounded-full transition-all duration-500"
                        style={{ width: `${Math.round(score * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-[var(--text)]">{Math.round(score * 100)}%</span>
                  </div>
                ))}
            </div>
          )}
          {post.styleNotes && (
            <div className="mt-3 p-3 rounded-xl bg-[var(--code-bg)]">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text)] mb-1">Notes on Composition</p>
              <p className="text-xs text-[var(--text)] leading-relaxed">{post.styleNotes}</p>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-4 px-3 py-3">
        {/* Like */}
        <button
          onClick={onLike}
          disabled={liking}
          className={`flex items-center gap-1 text-sm p-2 -ml-2 rounded-lg hover:bg-[var(--accent-bg)] transition disabled:opacity-50 min-h-[44px] min-w-[44px] ${
            isLiked ? 'text-pink-500' : 'text-gray-500 hover:text-pink-500'
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill={isLiked ? 'currentColor' : 'none'}
            viewBox="0 0 24 24"
            strokeWidth="1.5"
            stroke="currentColor"
            className="size-5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"
            />
          </svg>
          {post.likesCount ?? 0}
        </button>

        {/* Comment toggle */}
        <button
          onClick={handleToggleComments}
          className={`flex items-center gap-1 text-sm p-2 rounded-lg hover:bg-[var(--accent-bg)] transition min-h-[44px] min-w-[44px] ${
            showComments ? 'text-[var(--accent)]' : 'text-gray-500 hover:text-[var(--accent)]'
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="1.5"
            stroke="currentColor"
            className="size-5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
            />
          </svg>
          {post.commentsCount ?? 0}
        </button>
      </div>

      {/* Comment section */}
      {showComments && (
        <div className="px-3 pb-3 border-t border-gray-100">
          {loadingComments ? (
            <p className="text-xs text-gray-400 py-2">Loading comments...</p>
          ) : (
            <div className="flex flex-col gap-1.5 py-2 max-h-40 overflow-y-auto">
              {comments.length === 0 && (
                <p className="text-xs text-gray-400">No comments yet. Be first!</p>
              )}
              {comments.map(c => (
                <div key={c.id} className="text-xs leading-relaxed">
                  <span className="font-medium text-gray-700">@{c.authorEmail}</span>{' '}
                  <span className="text-gray-600">{c.content}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 mt-1">
            <input
              type="text"
              value={newComment}
              onChange={e => setNewComment(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !submitting && handleAddComment()}
              placeholder="Add a comment..."
              className="flex-1 text-xs border border-gray-200 rounded-full px-3 py-1.5 focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleAddComment}
              disabled={submitting || !newComment.trim()}
              className="text-xs text-[var(--accent)] font-semibold disabled:opacity-40 shrink-0"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
