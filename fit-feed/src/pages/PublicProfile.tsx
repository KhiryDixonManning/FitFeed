import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getPostsByAuthor, toggleLike, getUserPreferences, type Post, followUser, unfollowUser, isFollowing, getFollowerCount, getFollowingCount } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import { auth, db } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { formatAuthor } from '../utils/formatAuthor';
import PostImage from '../components/PostImage';
import EmptyState from '../components/EmptyState';
import { ProfileHeaderSkeleton, GridTileSkeleton } from '../components/Skeletons';

export default function PublicProfile() {
  const { uid } = useParams<{ uid: string }>();
  const navigate = useNavigate();
  const [posts, setPosts] = useState<Post[]>([]);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [authorPhotoURL, setAuthorPhotoURL] = useState('');
  const [topCategory, setTopCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const currentUid = auth.currentUser?.uid ?? '';

  const [following, setFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [followLoading, setFollowLoading] = useState(false);

  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    const load = async () => {
      // Any single failed read must never leave the page stuck on the spinner
      try {
        try {
          const userDoc = await getDoc(doc(db, 'users', uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            setEmail(data.email || '');
            setUsername(data.username || '');
            setAuthorPhotoURL(data.photoURL || '');
          }
        } catch {
          // user doc may not exist for older accounts
        }

        const [authorPosts, prefs, isFollowingUser, followerCountResult, followingCountResult] = await Promise.all([
          getPostsByAuthor(uid),
          getUserPreferences(uid),
          currentUid && currentUid !== uid ? isFollowing(currentUid, uid) : Promise.resolve(false),
          getFollowerCount(uid),
          getFollowingCount(uid),
        ]);

        setPosts(authorPosts);

        if (Object.keys(prefs).length > 0) {
          const top = Object.entries(prefs).sort((a, b) => b[1] - a[1])[0][0];
          setTopCategory(top);
        }

        setFollowing(isFollowingUser);
        setFollowerCount(followerCountResult);
        setFollowingCount(followingCountResult);
      } catch (err) {
        console.error('[PublicProfile] Failed to load:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [uid, currentUid]);

  const handleFollow = async () => {
    if (!currentUid || currentUid === uid) return;
    setFollowLoading(true);
    if (following) {
      await unfollowUser(currentUid, uid!);
      setFollowing(false);
      setFollowerCount(prev => prev - 1);
    } else {
      await followUser(currentUid, uid!);
      setFollowing(true);
      setFollowerCount(prev => prev + 1);
    }
    setFollowLoading(false);
  };

  const handleLike = async (post: Post) => {
    if (!currentUid) return;
    const wasLiked = post.likedBy?.includes(currentUid);

    setPosts(prev => prev.map(p =>
      p.id === post.id
        ? {
            ...p,
            likesCount: wasLiked ? (p.likesCount || 1) - 1 : (p.likesCount || 0) + 1,
            likedBy: wasLiked
              ? p.likedBy?.filter(id => id !== currentUid)
              : [...(p.likedBy || []), currentUid],
          }
        : p
    ));

    const didLike = await toggleLike(post.id, currentUid);
    if (didLike && post.category) {
      await recordInteraction(currentUid, post.category, 'like');
    }
  };

  if (loading) return (
    <div className="max-w-2xl mx-auto py-6 text-left pb-24 md:pb-6">
      <div className="px-4 md:px-0">
        <ProfileHeaderSkeleton />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 px-4 md:px-0">
        {[0, 1, 2].map(i => <GridTileSkeleton key={i} />)}
      </div>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto py-6 text-left pb-24 md:pb-6">
      {/* Profile header */}
      <div className="flex items-start justify-between mb-6 px-4 md:px-0">
        <div className="flex items-center gap-3">
          {/* Avatar */}
          <div className="w-16 h-16 rounded-full bg-[var(--bg-secondary)] border-2 border-[var(--border)] flex items-center justify-center text-2xl overflow-hidden shrink-0">
            {authorPhotoURL
              ? <img src={authorPhotoURL} alt="avatar" className="w-full h-full object-cover" loading="lazy" decoding="async" />
              : '👤'}
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--text-h)]">
              {formatAuthor(email || `user_${uid!.slice(0, 6)}`, username)}
            </h2>
            <div className="flex gap-4 mt-1">
              <span className="text-xs text-[var(--text)]">
                <span className="font-semibold text-[var(--text-h)]">{followerCount}</span> followers
              </span>
              <span className="text-xs text-[var(--text)]">
                <span className="font-semibold text-[var(--text-h)]">{followingCount}</span> following
              </span>
            </div>
            {topCategory && (
              <p className="text-xs text-[var(--text)] mt-1">
                Top style: <span className="text-[var(--accent)] font-medium capitalize">{topCategory}</span>
              </p>
            )}
            <p className="text-xs text-[var(--text)] mt-0.5">{posts.length} {posts.length === 1 ? 'post' : 'posts'}</p>
          </div>
        </div>

        {/* Follow button — only show if viewing someone else's profile */}
        {currentUid && currentUid !== uid && (
          <button
            onClick={handleFollow}
            disabled={followLoading}
            className={`px-4 py-2 rounded-full text-sm font-medium transition shrink-0 ${
              following
                ? 'border border-[var(--border)] text-[var(--text)] hover:border-red-300 hover:text-red-500'
                : 'bg-[var(--accent)] text-white hover:opacity-90'
            } disabled:opacity-50`}
          >
            {followLoading ? '...' : following ? 'Following' : 'Follow'}
          </button>
        )}
      </div>

      {posts.length === 0 ? (
        <EmptyState
          title="No fits posted yet"
          message="When they share their first fit, it will show up here."
          compact
        />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 px-4 md:px-0">
          {posts.map(post => (
            <div
              key={post.id}
              onClick={() => navigate(`/post/${post.id}`)}
              className="border border-[var(--border)] rounded-lg overflow-hidden cursor-pointer hover:border-[var(--accent)] transition-colors"
            >
              <PostImage src={post.imageUrl} alt="outfit" className="w-full aspect-square object-cover" />
              <div className="p-3">
                <p className="text-sm text-[var(--text-h)] mb-1 truncate">{post.outfitName || post.content}</p>
                {post.category && (
                  <span className="text-xs bg-[var(--accent)] text-white rounded-full px-2 py-0.5">
                    {post.category}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleLike(post); }}
                  className="mt-2 flex items-center gap-1 text-sm text-[var(--text)] hover:text-[var(--accent)] transition"
                >
                  {post.likedBy?.includes(currentUid) ? '❤️' : '🤍'} {post.likesCount || 0}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
