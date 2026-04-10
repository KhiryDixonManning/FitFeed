import { useEffect, useState } from 'react';
import { getPosts, toggleLike, getUserPreferences } from '../FirebaseDB';
import type { Post } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import { auth } from '../../firebase';

interface ProfileProps {
  uid: string;
}

export default function Profile({ uid }: ProfileProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [topCategory, setTopCategory] = useState<string>('None yet');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const allPosts = await getPosts();
      const myPosts = allPosts.filter(p => p.authorId === uid);
      setPosts(myPosts);

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
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[var(--text-h)]">My Profile</h2>
        <p className="text-[var(--text)] text-sm">{auth.currentUser?.email}</p>
        <p className="text-[var(--text)] text-sm mt-1">
          Top style: <span className="text-[var(--accent)] font-medium">{topCategory}</span>
        </p>
      </div>

      {posts.length === 0 ? (
        <p className="text-[var(--text)] text-sm">No posts yet. Upload your first fit!</p>
      ) : (
        <div className="grid grid-cols-2 gap-4">
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
