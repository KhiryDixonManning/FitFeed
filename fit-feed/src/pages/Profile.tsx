import { useEffect, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { getPosts, toggleLike, getUserPreferences } from '../FirebaseDB';
import type { Post } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import { auth, db } from '../../firebase';
import StyleProfile from '../components/StyleProfile';

interface ProfileProps {
  uid: string;
}

export default function Profile({ uid }: ProfileProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [userPreferences, setUserPreferences] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const allPosts = await getPosts();
      const myPosts = allPosts.filter(p => p.authorId === uid);
      setPosts(myPosts);

      const prefs = await getUserPreferences(uid);
      setUserPreferences(prefs);

      // Silently ensure current user has a users document (backfills older accounts)
      if (auth.currentUser) {
        setDoc(doc(db, 'users', auth.currentUser.uid), {
          uid: auth.currentUser.uid,
          email: auth.currentUser.email,
          displayName: auth.currentUser.displayName || '',
          createdAt: new Date().toISOString(),
        }, { merge: true }).catch(console.error);
      }

      setLoading(false);
    };
    load();
  }, [uid]);

  const handleLike = async (post: Post) => {
    const wasLiked = post.likedBy?.includes(uid);

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

    const didLike = await toggleLike(post.id, uid);
    if (didLike && post.category) {
      await recordInteraction(uid, post.category, 'like');
    }
  };

  if (loading) return <div className="p-8 text-center text-[var(--text)]">Loading profile...</div>;

  return (
    <div className="max-w-2xl mx-auto py-6 px-0 md:px-6 pb-24 md:pb-6">
      <div className="px-4 md:px-0 mb-4">
        <h2 className="text-2xl font-bold text-[var(--text-h)]">My Profile</h2>
        <p className="text-[var(--text)] text-sm">{auth.currentUser?.email}</p>
      </div>

      {/* Style Profile */}
      <div className="mb-6 px-4 md:px-0">
        <StyleProfile preferences={userPreferences} />
      </div>

      {posts.length === 0 ? (
        <p className="text-[var(--text)] text-sm px-4 md:px-0">No posts yet. Upload your first fit!</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-3 px-4 md:px-0">
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
                  {post.likedBy?.includes(uid) ? '❤️' : '🤍'} {post.likesCount || 0}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
