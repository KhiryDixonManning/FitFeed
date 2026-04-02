import { useState } from 'react';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { addPost } from '../FirebaseDB';
import { CATEGORIES, type Category } from '../constants/categories';

interface Props {
  uid: string;
}

export default function Upload({ uid }: Props) {
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [category, setCategory] = useState<Category | ''>('');
  const [outfitBreakdown, setOutfitBreakdown] = useState('');
  const [uploading, setUploading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setImage(file);
    setSuccess(false);
    if (file) {
      const url = URL.createObjectURL(file);
      setPreview(url);
    } else {
      setPreview(null);
    }
  };

  const handleSubmit = async () => {
    if (!image) { setError('Please select an image.'); return; }
    if (!category) { setError('Please select a category.'); return; }
    setError('');
    setUploading(true);
    try {
      const storage = getStorage();
      const storageRef = ref(storage, `posts/${uid}/${Date.now()}_${image.name}`);
      await uploadBytes(storageRef, image);
      const imageUrl = await getDownloadURL(storageRef);

      await addPost({
        id: '',
        authorId: uid,
        content: caption,
        imageUrl,
        category,
        outfitBreakdown,
        likesCount: 0,
        commentsCount: 0,
      });

      setSuccess(true);
      setImage(null);
      setPreview(null);
      setCaption('');
      setCategory('');
      setOutfitBreakdown('');
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="px-6 py-8 max-w-lg mx-auto text-left">
      <h2 className="text-2xl font-bold text-[var(--text-h)] mb-6">Share Your Fit</h2>

      {/* Image upload */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-h)] mb-1">Photo</label>
        <label className="flex flex-col items-center justify-center w-full aspect-[4/5] rounded-xl border-2 border-dashed border-[var(--border)] cursor-pointer hover:border-[var(--accent)] transition-colors overflow-hidden bg-[var(--accent-bg)]">
          {preview ? (
            <img src={preview} alt="preview" className="w-full h-full object-cover" />
          ) : (
            <span className="text-[var(--text)] text-sm">Click to select photo</span>
          )}
          <input type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
        </label>
      </div>

      {/* Caption */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-h)] mb-1">Caption</label>
        <input
          type="text"
          placeholder="Describe your outfit..."
          value={caption}
          onChange={e => setCaption(e.target.value)}
          className="w-full border border-[var(--border)] rounded-lg px-3 py-2 bg-[var(--bg)] text-[var(--text-h)] text-sm focus:outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* Category */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-h)] mb-2">Category</label>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={`px-3 py-1 rounded-full text-sm font-medium capitalize transition-colors ${
                category === cat
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--accent-bg)] text-[var(--text)] hover:text-[var(--text-h)]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Outfit breakdown */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-[var(--text-h)] mb-1">Outfit Breakdown</label>
        <textarea
          placeholder="Break down your outfit pieces (e.g. top, pants, shoes, accessories)..."
          value={outfitBreakdown}
          onChange={e => setOutfitBreakdown(e.target.value)}
          rows={4}
          className="w-full border border-[var(--border)] rounded-lg px-3 py-2 bg-[var(--bg)] text-[var(--text-h)] text-sm focus:outline-none focus:border-[var(--accent)] resize-none"
        />
      </div>

      {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
      {success && <p className="text-green-500 text-sm mb-3">Post uploaded successfully!</p>}

      <button
        onClick={handleSubmit}
        disabled={uploading}
        className="w-full bg-[var(--accent)] text-white rounded-lg px-4 py-2.5 font-medium hover:opacity-90 transition disabled:opacity-50"
      >
        {uploading ? 'Uploading...' : 'Post'}
      </button>
    </div>
  );
}
