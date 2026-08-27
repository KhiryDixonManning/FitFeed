import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { getPosts, type Post } from '../FirebaseDB';
import PostImage from '../components/PostImage';
import EmptyState from '../components/EmptyState';
import { GridTileSkeleton } from '../components/Skeletons';

export default function Explore() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tag = searchParams.get('tag');
  const color = searchParams.get('color');
  const category = searchParams.get('category');

  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const all = await getPosts();
      let filtered = all;

      if (tag) {
        filtered = all.filter(p =>
          p.aestheticTags?.some(t => t.toLowerCase() === tag.toLowerCase())
        );
      } else if (color) {
        filtered = all.filter(p =>
          p.palette?.some((c: any) => {
            const colorObj = typeof c === 'string' ? { name: c, hex: c } : c;
            return colorObj.name?.toLowerCase().includes(color.toLowerCase()) ||
                   colorObj.hex?.toLowerCase() === color.toLowerCase();
          })
        );
      } else if (category) {
        filtered = all.filter(p =>
          p.category === category || p.aesthetic === category
        );
      }

      setPosts(filtered);
      setLoading(false);
    };
    load();
  }, [tag, color, category]);

  const title = tag
    ? `#${tag}`
    : color
    ? `${color} outfits`
    : category
    ? category
    : 'Explore';

  return (
    <div className="max-w-2xl mx-auto p-4 pb-24">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate(-1)}
          className="text-[var(--text)] text-sm"
        >
          ← Back
        </button>
        <h2 className="text-2xl font-bold text-[var(--text-h)] capitalize">{title}</h2>
        {!loading && (
          <span className="text-xs text-[var(--text)] ml-auto">
            {posts.length} {posts.length === 1 ? 'post' : 'posts'}
          </span>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3, 5, 6].map(i => (
            <GridTileSkeleton key={i} withCaption={false} />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <EmptyState
          title={tag || color || category ? `Nothing tagged ${title} yet` : 'Nothing to explore yet'}
          message={tag || color || category
            ? 'As more fits get analyzed, this corner of the catalog will fill in.'
            : 'Once fits start landing, you can explore them by tag, color, and aesthetic here.'}
          action={{ label: 'Go back', onClick: () => navigate(-1) }}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {posts.map(post => (
            <div
              key={post.id}
              onClick={() => navigate(`/post/${post.id}`)}
              className="relative cursor-pointer rounded-xl overflow-hidden border border-[var(--border)] hover:border-[var(--accent)] transition"
            >
              <PostImage
                src={post.imageUrl}
                alt="outfit"
                className="w-full aspect-square object-cover"
              />
              <div className="absolute top-2 right-2 bg-black/70 rounded-full px-2 py-0.5 flex items-center gap-1">
                <span className="text-white text-xs">◎</span>
                <span className="text-white text-xs font-semibold">
                  {(post.likesCount || 0) + (post.commentsCount || 0)}
                </span>
              </div>
              {post.outfitName && (
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                  <p className="text-white text-xs font-medium truncate italic">
                    "{post.outfitName}"
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
