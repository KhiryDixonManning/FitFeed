import { useState, useEffect } from 'react';
import { getPosts, getUserPreferences, type Post } from '../FirebaseDB';
import { auth } from '../../firebase';

interface Props {
  uid: string;
}

export default function Profile({ uid }: Props) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [topCategory, setTopCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const email = auth.currentUser?.email ?? '';

  useEffect(() => {
    const load = async () => {
      const [allPosts, prefs] = await Promise.all([
        getPosts(),
        getUserPreferences(uid),
      ]);
      setPosts(allPosts.filter(p => p.authorId === uid));
      const entries = Object.entries(prefs);
      if (entries.length > 0) {
        const top = entries.sort(([, a], [, b]) => b - a)[0][0];
        setTopCategory(top);
      }
      setLoading(false);
    };
    load();
  }, [uid]);

  if (loading) return <div className="p-8 text-center text-[var(--text)]">Loading profile...</div>;

  return (
    <div className="px-6 py-4 text-left">
      {/* Profile header */}
      <div className="flex items-center gap-4 mb-8">
        <div className="w-16 h-16 rounded-full bg-[var(--accent-bg)] border-2 border-[var(--accent-border)] flex items-center justify-center text-2xl font-bold text-[var(--accent)] shrink-0">
          {email.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="font-semibold text-[var(--text-h)]">{email}</p>
          <p className="text-sm text-[var(--text)] mt-0.5">
            {posts.length} {posts.length === 1 ? 'post' : 'posts'}
          </p>
          {topCategory && (
            <p className="text-sm text-[var(--text)] mt-1">
              Top style:{' '}
              <span className="bg-[var(--accent)] text-white rounded-full px-2 py-0.5 text-xs capitalize">
                {topCategory}
              </span>
            </p>
          )}
        </div>
      </div>

      {/* Posts grid */}
      {posts.length === 0 ? (
        <p className="text-center text-[var(--text)] py-12">
          No posts yet. Start sharing your fits!
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {posts.map(post => (
            <div
              key={post.id}
              className="relative aspect-square overflow-hidden rounded-lg bg-[var(--accent-bg)]"
            >
              {post.imageUrl ? (
                <img
                  src={post.imageUrl}
                  alt={post.content ?? 'outfit'}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-[var(--text)]">
                  No image
                </div>
              )}
              {post.category && (
                <span className="absolute bottom-1 left-1 bg-[var(--accent)] text-white rounded-full px-2 py-0.5 text-xs capitalize">
                  {post.category}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
