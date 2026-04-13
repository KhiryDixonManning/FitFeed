import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../../firebase';
import { addComment, getComments, type Comment, type Post } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import ProfileAvatar from './ProfileAvatar';

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
    <div className="rounded-2xl shadow-lg bg-white overflow-hidden flex flex-col">
      {/* Image — tapping navigates to author profile */}
      <div
        className="overflow-hidden cursor-pointer bg-gray-100"
        onClick={() => navigate(`/profile/${post.authorId}`)}
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

      {/* Color palette — shows whenever palette exists even if full analysis failed */}
      {post.palette && post.palette.length > 0 && (
        <div className="flex gap-1 px-3 mt-2">
          {post.palette.map((hex, i) => (
            <div
              key={i}
              className="w-5 h-5 rounded-full border border-[var(--border)]"
              style={{ backgroundColor: hex }}
              title={hex}
            />
          ))}
        </div>
      )}

      {/* Full analysis — only shows when Claude analysis succeeded */}
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
                    <span className="text-xs text-[var(--text)] w-24 capitalize">
                      {label}
                    </span>
                    <div className="flex-1 h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent)] rounded-full"
                        style={{ width: `${Math.round(score * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-[var(--text)]">
                      {Math.round(score * 100)}%
                    </span>
                  </div>
                ))}
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
