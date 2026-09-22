import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { addPost } from '../FirebaseDB';
import { CATEGORIES, type Category } from '../constants/categories';
import { requestAnalysis } from '../api';
import { compressToJpegFile, isAcceptedImage } from '../utils/image';

// Ask the backend to analyse the new post. The browser no longer receives or
// writes the analysis itself: the server authenticates the caller, reads the
// image URL from Firestore, runs the model and writes the result with the
// Admin SDK. A failure here is not fatal - PostDetail shows an honest waiting
// state and the server records analysisStatus.
async function triggerAnalysis(postId: string): Promise<void> {
  try {
    await requestAnalysis(postId);
  } catch (err) {
    console.error('[triggerAnalysis] Request failed:', err);
  }
}

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
    if (!file) return;
    if (!isAcceptedImage(file)) {
      setError('Please choose a JPG, PNG, WEBP or HEIC image.');
      return;
    }
    setError('');
    setImage(file);
    setPreview(URL.createObjectURL(file));
  };

  const handlePublish = async () => {
    if (!image) { setError('Please select an image.'); return; }
    if (!category) { setError('Please select a category.'); return; }
    if (!caption.trim()) { setError('Please add a caption.'); return; }

    setLoading(true);
    setError('');

    try {
      const storage = getStorage();
      const compressedFile = await compressToJpegFile(image);
      const storageRef = ref(storage, `posts/${uid}/${Date.now()}_${compressedFile.name}`);
      await uploadBytes(storageRef, compressedFile);
      const imageUrl = await getDownloadURL(storageRef);

      const result = await addPost({
        authorId: uid,
        content: caption,
        imageUrl,
        category: category as Category,
        outfitBreakdown,
        likesCount: 0,
        commentsCount: 0,
        likedBy: [],
        analysisStatus: 'pending',
      });

      if (result) {
        // Land on the new post so the analysis composes in front of the
        // author; the analyze call itself stays fire-and-forget.
        triggerAnalysis(result.id);
        navigate(`/post/${result.id}`, { state: { justPublished: true } });
      } else {
        navigate('/');
      }
    } catch (err: unknown) {
      setError(err instanceof Error && err.message
        ? err.message
        : 'Failed to publish. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen pb-24 md:pb-6">
      <div className="max-w-lg mx-auto p-4 md:p-6 pb-32 md:pb-6">
        <h2 className="text-2xl font-bold text-[var(--text-h)] mb-6">Upload Fit</h2>

        <div className="flex flex-col gap-4">
          <label className="block w-full cursor-pointer">
            <div className={`border-2 border-dashed rounded-xl overflow-hidden flex flex-col items-center justify-center gap-3 py-10 transition ${
              preview ? 'border-[var(--accent)] p-0' : 'border-[var(--border)] hover:border-[var(--accent-border)]'
            }`}>
              {preview ? (
                <div className="relative w-full">
                  <img src={preview} alt="preview" className="w-full aspect-square object-cover" />
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); setImage(null); setPreview(null); }}
                    className="absolute top-2 right-2 bg-black/60 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg hover:bg-black/80 transition"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-4xl">📸</span>
                  <p className="text-sm text-[var(--text)] text-center">Tap to select a photo</p>
                  <p className="text-xs text-[var(--text)] opacity-50">JPG, PNG, HEIC supported</p>
                </>
              )}
            </div>
            <input
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              className="hidden"
            />
          </label>

          <input
            type="text"
            placeholder="Caption"
            value={caption}
            onChange={e => setCaption(e.target.value)}
            className="w-full border border-[var(--border)] rounded-lg px-3 py-3 bg-[var(--bg)] text-[var(--text-h)] text-base"
          />

          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="w-full border border-[var(--border)] rounded-lg px-3 py-3 bg-[var(--bg)] text-[var(--text-h)] text-base"
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
            className="w-full border border-[var(--border)] rounded-lg px-3 py-3 bg-[var(--bg)] text-[var(--text-h)] text-base resize-none"
          />
        </div>
      </div>

      {/* Sticky publish button on mobile, inline on desktop */}
      <div className="fixed left-0 right-0 px-4 pt-2 bg-[var(--bg)] border-t border-[var(--border)] md:relative md:left-auto md:right-auto md:px-0 md:pt-0 md:bg-transparent md:border-none z-40 bottom-safe-nav">
        <div className="max-w-lg mx-auto">
          {error && <p className="text-red-500 text-sm mb-2">{error}</p>}
          <button
            onClick={handlePublish}
            disabled={loading}
            className="w-full bg-[var(--accent)] text-white rounded-lg px-4 py-3 font-medium hover:opacity-90 transition disabled:opacity-50 text-base"
          >
            {loading ? 'Saving your fit...' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
