import { useState, useEffect } from "react";
import PostCard from "../components/Post";
import { getRankedFeed, recordInteraction } from "../feedService";
import { toggleLike } from "../FirebaseDB";
import type { Post } from "../FirebaseDB";

interface FeedProps {
  uid: string;
}

export default function Feed({ uid }: FeedProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiOnline, setApiOnline] = useState(true);
  const [likingIds, setLikingIds] = useState<Set<string>>(new Set());

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
      setLoading(false);
    };
    fetchFeed();
  }, [uid]);

  const handleLike = async (post: Post) => {
    if (likingIds.has(post.id)) return;

    const wasLiked = post.likedBy?.includes(uid) ?? false;

    // Optimistic update — update UI instantly before Firestore confirms
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
          <div className="text-center text-gray-400 py-12">No posts yet.</div>
        ) : (
          <div className="grid grid-cols-2 gap-6 auto-rows-max">
            {posts.map((post) => (
              <PostCard
                key={post.id}
                imageUrl={post.imageUrl ?? ""}
                username={post.authorId}
                caption={post.content ?? ""}
                likeCount={post.likesCount ?? 0}
                commentCount={post.commentsCount ?? 0}
                isLiked={post.likedBy?.includes(uid) ?? false}
                onLike={() => handleLike(post)}
                liking={likingIds.has(post.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
