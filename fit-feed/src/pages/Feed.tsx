import { useState, useEffect } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import PostCard from "../components/PostCard";
import { getRankedFeed, recordInteraction } from "../feedService";
import { toggleLike, type Post } from "../FirebaseDB";

interface FeedProps {
  uid: string;
}

export default function Feed({ uid }: FeedProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiOnline, setApiOnline] = useState(true);
  const [likingIds, setLikingIds] = useState<Set<string>>(new Set());
  const [authorEmails, setAuthorEmails] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/health")
      .then(res => { if (!res.ok) setApiOnline(false); })
      .catch(() => setApiOnline(false));
  }, []);

  useEffect(() => {
    const fetchFeed = async () => {
      setLoading(true);
      const ranked = await getRankedFeed(uid);
      setPosts(ranked);

      // Batch-fetch author emails so posts show readable names instead of UIDs
      const emailMap: Record<string, string> = {};
      await Promise.all(
        ranked.map(async (post) => {
          if (!emailMap[post.authorId]) {
            try {
              const userDoc = await getDoc(doc(db, 'users', post.authorId));
              emailMap[post.authorId] = userDoc.exists()
                ? (userDoc.data().email || post.authorId)
                : post.authorId;
            } catch {
              emailMap[post.authorId] = post.authorId;
            }
          }
        })
      );
      setAuthorEmails(emailMap);
      setLoading(false);
    };
    fetchFeed();
  }, [uid]);

  const handleLike = async (post: Post) => {
    if (likingIds.has(post.id)) return;

    const wasLiked = post.likedBy?.includes(uid) ?? false;

    // Optimistic update
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

    setLikingIds(prev => new Set(prev).add(post.id));

    const didLike = await toggleLike(post.id, uid);
    if (didLike && post.category) {
      await recordInteraction(uid, post.category, "like");
    }

    setLikingIds(prev => {
      const next = new Set(prev);
      next.delete(post.id);
      return next;
    });
  };

  const handleCommentAdded = (postId: string) => {
    setPosts(prev => prev.map(p =>
      p.id === postId ? { ...p, commentsCount: (p.commentsCount || 0) + 1 } : p
    ));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {!apiOnline && (
        <div className="bg-yellow-100 text-yellow-800 text-sm px-4 py-2 text-center">
          Ranking server is offline — showing unranked posts
        </div>
      )}
      <div className="p-6">
        {loading ? (
          <div className="text-center text-gray-400 py-12">Loading feed...</div>
        ) : posts.length === 0 ? (
          <div className="text-center text-gray-400 py-12">No posts yet. Be the first to share a fit!</div>
        ) : (
          <div className="grid grid-cols-1 gap-6 auto-rows-max md:grid-cols-2">
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                uid={uid}
                authorEmail={authorEmails[post.authorId] || post.authorId}
                isLiked={post.likedBy?.includes(uid) ?? false}
                onLike={() => handleLike(post)}
                liking={likingIds.has(post.id)}
                onCommentAdded={handleCommentAdded}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
