import { useEffect, useState } from 'react';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getPosts, toggleLike, getUserPreferences } from '../FirebaseDB';
import type { Post } from '../FirebaseDB';
import { recordInteraction } from '../feedService';
import { auth, db } from '../../firebase';
import StyleProfile from '../components/StyleProfile';
import { useNavigate } from 'react-router-dom';

interface ProfileProps {
  uid: string;
}

export default function Profile({ uid }: ProfileProps) {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<Post[]>([]);
  const [userPreferences, setUserPreferences] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  // Username state
  const [username, setUsername] = useState('');
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');

  // Avatar state
  const [photoURL, setPhotoURL] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);

  useEffect(() => {
    const load = async () => {
      const allPosts = await getPosts();
      const myPosts = allPosts.filter(p => p.authorId === uid);
      setPosts(myPosts);

      const prefs = await getUserPreferences(uid);
      setUserPreferences(prefs);

      // Load username and avatar from users collection
      if (auth.currentUser) {
        const userDoc = await getDoc(doc(db, 'users', auth.currentUser.uid));
        if (userDoc.exists()) {
          const data = userDoc.data();
          setUsername(data.username || '');
          setPhotoURL(data.photoURL || '');
        }

        // Backfill user doc for older accounts
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

  const saveUsername = async () => {
    if (!usernameInput.trim()) return;
    const cleaned = usernameInput.trim().toLowerCase().replace(/\s+/g, '_');
    await setDoc(doc(db, 'users', uid), { username: cleaned }, { merge: true });
    setUsername(cleaned);
    setEditingUsername(false);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const storage = getStorage();
      const storageRef = ref(storage, `avatars/${uid}/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await setDoc(doc(db, 'users', uid), { photoURL: url }, { merge: true });
      setPhotoURL(url);
    } catch (err) {
      console.error('Avatar upload failed:', err);
    } finally {
      setAvatarUploading(false);
    }
  };

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
      {/* Profile header */}
      <div className="px-4 md:px-0 mb-6 flex items-start gap-4">
        {/* Avatar */}
        <div className="relative shrink-0">
          {photoURL ? (
            <img
              src={photoURL}
              alt="avatar"
              className="w-20 h-20 rounded-full object-cover border-2 border-[var(--border)]"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-[var(--bg-secondary)] border-2 border-[var(--border)] flex items-center justify-center text-2xl">
              👤
            </div>
          )}
          <label className="absolute bottom-0 right-0 bg-[var(--accent)] text-white rounded-full w-6 h-6 flex items-center justify-center cursor-pointer text-xs hover:opacity-90 transition">
            {avatarUploading ? '…' : '+'}
            <input type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
          </label>
        </div>

        {/* Username + email */}
        <div className="flex-1 min-w-0">
          {username ? (
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-lg font-bold text-[var(--text-h)]">@{username}</p>
              <button
                onClick={() => { setEditingUsername(true); setUsernameInput(username); }}
                className="text-xs text-[var(--text)] underline"
              >
                edit
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingUsername(true)}
              className="text-sm text-[var(--accent)] underline"
            >
              + Add username
            </button>
          )}
          <p className="text-[var(--text)] text-sm mt-0.5">{auth.currentUser?.email}</p>

          {editingUsername && (
            <div className="flex gap-2 mt-2 flex-wrap">
              <input
                type="text"
                value={usernameInput}
                onChange={e => setUsernameInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveUsername()}
                placeholder="your_username"
                className="border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm bg-[var(--bg)] text-[var(--text-h)] flex-1 min-w-0"
              />
              <button
                onClick={saveUsername}
                className="bg-[var(--accent)] text-white rounded-lg px-3 py-1.5 text-sm"
              >
                Save
              </button>
              <button
                onClick={() => setEditingUsername(false)}
                className="border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text)]"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
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
            <div
              key={post.id}
              className="border border-[var(--border)] rounded-lg overflow-hidden cursor-pointer hover:border-[var(--accent)] transition-colors"
              onClick={() => navigate(`/post/${post.id}`)}
            >
              {post.imageUrl && (
                <img src={post.imageUrl} alt="outfit" className="w-full aspect-square object-cover" />
              )}
              <div className="p-3">
                <p className="text-sm text-[var(--text-h)] mb-1 truncate">{post.content}</p>
                {post.category && (
                  <span className="text-xs bg-[var(--accent)] text-white rounded-full px-2 py-0.5">
                    {post.category}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleLike(post); }}
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
