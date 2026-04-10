import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { addPost } from '../FirebaseDB';
import { CATEGORIES } from '../constants/categories';

interface UploadProps {
  uid: string;
}

export default function Upload({ uid }: UploadProps) {
  const navigate = useNavigate();
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [category, setCategory] = useState('');
  const [outfitBreakdown, setOutfitBreakdown] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImage(file);
      setPreview(URL.createObjectURL(file));
    }
  };

  const handlePublish = async () => {
    if (!image) { setError('Please select an image.'); return; }
    if (!category) { setError('Please select a category.'); return; }
    if (!caption.trim()) { setError('Please add a caption.'); return; }

    setLoading(true);
    setError('');

    try {
      const storage = getStorage();
      const storageRef = ref(storage, `posts/${uid}/${Date.now()}_${image.name}`);
      await uploadBytes(storageRef, image);
      const imageUrl = await getDownloadURL(storageRef);

      await addPost({
        authorId: uid,
        content: caption,
        imageUrl,
        category: category as any,
        outfitBreakdown,
        likesCount: 0,
        commentsCount: 0,
        likedBy: [],
      });

      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Failed to publish. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto p-6">
      <h2 className="text-2xl font-bold text-[var(--text-h)] mb-6">Upload Fit</h2>

      <div className="flex flex-col gap-4">
        <div className="border-2 border-dashed border-[var(--border)] rounded-lg p-6 text-center">
          {preview ? (
            <img src={preview} alt="preview" className="w-full aspect-square object-cover rounded-lg" />
          ) : (
            <p className="text-[var(--text)] text-sm">Click to select an image</p>
          )}
          <input
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            className="mt-3 text-sm text-[var(--text)]"
          />
        </div>

        <input
          type="text"
          placeholder="Caption"
          value={caption}
          onChange={e => setCaption(e.target.value)}
          className="border border-[var(--border)] rounded px-3 py-2 bg-[var(--bg)] text-[var(--text-h)] text-sm"
        />

        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="border border-[var(--border)] rounded px-3 py-2 bg-[var(--bg)] text-[var(--text-h)] text-sm"
        >
          <option value="">Select a category</option>
          {CATEGORIES.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>

        <textarea
          placeholder="Outfit breakdown (e.g. thrifted Levi jacket, vintage Nikes...)"
          value={outfitBreakdown}
          onChange={e => setOutfitBreakdown(e.target.value)}
          rows={3}
          className="border border-[var(--border)] rounded px-3 py-2 bg-[var(--bg)] text-[var(--text-h)] text-sm resize-none"
        />

        {error && <p className="text-red-500 text-sm">{error}</p>}

        <button
          onClick={handlePublish}
          disabled={loading}
          className="bg-[var(--accent)] text-white rounded px-4 py-2 font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? 'Publishing...' : 'Publish'}
        </button>
      </div>
    </div>
  );
}
