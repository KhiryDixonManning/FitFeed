import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPosts, toggleLike, getUserPreferences, type Post } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import { auth, db } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { formatAuthor } from '../utils/formatAuthor';

export default function PublicProfile() {
  const { uid } = useParams<{ uid: string }>();
  const [posts, setPosts] = useState<Post[]>([]);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [topCategory, setTopCategory] = useState('None yet');
  const [loading, setLoading] = useState(true);
  const currentUid = auth.currentUser?.uid ?? '';

  useEffect(() => {
    if (!uid) return;
    const load = async () => {
      // Get author info from users collection
      try {
        const userDoc = await getDoc(doc(db, 'users', uid));
        if (userDoc.exists()) {
          const data = userDoc.data();
          setEmail(data.email || '');
          setUsername(data.username || '');
        }
      } catch {
        // user doc may not exist for older accounts
      }

      // Get their posts
      const allPosts = await getPosts();
      setPosts(allPosts.filter(p => p.authorId === uid));

      // Get their top style category
      const prefs = await getUserPreferences(uid);
      if (Object.keys(prefs).length > 0) {
        const top = Object.entries(prefs).sort((a, b) => b[1] - a[1])[0][0];
        setTopCategory(top);
      }

      setLoading(false);
    };
    load();
  }, [uid]);

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

  if (loading) return <div className="p-8 text-center text-[var(--text)]">Loading profile...</div>;

  return (
    <div className="max-w-2xl mx-auto py-6 text-left">
      <div className="px-4 md:px-0 mb-6">
        <h2 className="text-2xl font-bold text-[var(--text-h)]">
          {formatAuthor(email || `user_${uid!.slice(0, 6)}`, username)}
        </h2>
        <p className="text-[var(--text)] text-sm mt-1">
          Top style: <span className="text-[var(--accent)] font-medium">{topCategory}</span>
        </p>
        <p className="text-[var(--text)] text-sm mt-0.5">{posts.length} {posts.length === 1 ? 'post' : 'posts'}</p>
      </div>

      {posts.length === 0 ? (
        <p className="text-[var(--text)] text-sm px-4 md:px-0">No posts yet.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 px-4 md:px-0">
          {posts.map(post => (
            <div key={post.id} className="border border-[var(--border)] rounded-lg overflow-hidden">
              {post.imageUrl && (
                <img src={post.imageUrl} alt="outfit" className="w-full aspect-square object-cover" />
              )}
              <div className="p-3">
                <p className="text-sm text-[var(--text-h)] mb-1">{post.content}</p>
                {post.category && (
                  <span className="text-xs bg-[var(--accent)] text-white rounded-full px-2 py-0.5">
                    {post.category}
                  </span>
                )}
                <button
                  onClick={() => handleLike(post)}
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
