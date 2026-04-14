import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { addPost } from '../FirebaseDB';
import { CATEGORIES } from '../constants/categories';

async function triggerAnalysis(postId: string, imageUrl: string): Promise<void> {
  console.log('[triggerAnalysis] Starting for postId:', postId, 'imageUrl:', imageUrl);
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl }),
    });

    console.log('[triggerAnalysis] Response status:', response.status);

    if (response.ok) {
      const analysis = await response.json();
      console.log('[triggerAnalysis] Analysis received:', analysis);

      if (analysis.analyzed) {
        await updateDoc(doc(db, 'posts', postId), {
          palette: analysis.palette || [],
          aesthetic: analysis.aesthetic || null,
          aestheticTags: analysis.aestheticTags || [],
          detectedItems: analysis.detectedItems || [],
          styleDescription: analysis.styleDescription || null,
          aestheticScores: analysis.aestheticScores || {},
          analyzed: true,
        });
        console.log('[triggerAnalysis] Firestore updated successfully');
      } else {
        console.warn('[triggerAnalysis] analyzed=false, not writing to Firestore');
      }
    } else {
      console.error('[triggerAnalysis] Bad response from /api/analyze:', response.status);
    }
  } catch (err) {
    console.error('[triggerAnalysis] Failed:', err);
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
    if (file) {
      setImage(file);
      setPreview(URL.createObjectURL(file));
    }
  };

  const compressImage = (file: File, maxWidth = 1200, quality = 0.8): Promise<Blob> => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        const ratio = Math.min(maxWidth / img.width, maxWidth / img.height, 1);
        canvas.width = img.width * ratio;
        canvas.height = img.height * ratio;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          (blob) => resolve(blob!),
          'image/jpeg',
          quality
        );
      };
      img.src = url;
    });
  };

  const handlePublish = async () => {
    if (!image) { setError('Please select an image.'); return; }
    if (!category) { setError('Please select a category.'); return; }
    if (!caption.trim()) { setError('Please add a caption.'); return; }

    setLoading(true);
    setError('');

    try {
      const storage = getStorage();
      const compressedBlob = await compressImage(image);
      const compressedFile = new File([compressedBlob], image.name.replace(/\.[^.]+$/, '.jpg'), {
        type: 'image/jpeg',
      });
      const storageRef = ref(storage, `posts/${uid}/${Date.now()}_${compressedFile.name}`);
      await uploadBytes(storageRef, compressedFile);
      const imageUrl = await getDownloadURL(storageRef);

      const result = await addPost({
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

      // Fire-and-forget: analyze outfit after redirect, never block the user
      if (result) {
        triggerAnalysis(result.id, imageUrl);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to publish. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen pb-24 md:pb-6">
      <div className="max-w-lg mx-auto p-4 md:p-6 pb-32 md:pb-6">
        <h2 className="text-2xl font-bold text-[var(--text-h)] mb-6">Upload Fit</h2>

        <div className="flex flex-col gap-4">
          <div className="border-2 border-dashed border-[var(--border)] rounded-xl p-8 text-center cursor-pointer active:bg-[var(--accent-bg)] transition">
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
      <div className="fixed bottom-16 left-0 right-0 px-4 pb-2 bg-[var(--bg)] border-t border-[var(--border)] md:relative md:bottom-auto md:left-auto md:right-auto md:px-0 md:pb-0 md:bg-transparent md:border-none z-40">
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
