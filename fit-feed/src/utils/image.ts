// Client-side image preparation shared by post uploads and avatar uploads.
//
// Compressing before upload keeps every object comfortably under the 10 MB
// ceiling enforced by storage.rules, and keeps the bytes the backend analyser
// has to download small.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

export function isAcceptedImage(file: File): boolean {
  // Some browsers report an empty type for HEIC; fall back to the extension.
  if (file.type) return ACCEPTED_IMAGE_TYPES.includes(file.type.toLowerCase());
  return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name);
}

/**
 * Downscale to fit within maxWidth/maxHeight and re-encode as JPEG.
 * Rejects (rather than hanging) if the file cannot be decoded.
 */
export function compressImage(file: File, maxWidth = 1200, quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas is unavailable in this browser.'));
      return;
    }

    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const ratio = Math.min(maxWidth / img.width, maxWidth / img.height, 1);
      canvas.width = Math.max(1, Math.round(img.width * ratio));
      canvas.height = Math.max(1, Math.round(img.height * ratio));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Could not process this image.'));
        },
        'image/jpeg',
        quality
      );
    };

    // Without this a corrupt or unsupported file left the promise pending
    // forever, freezing the publish button.
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this image file.'));
    };

    img.src = url;
  });
}

/** Compress and wrap back into a File with a .jpg name. */
export async function compressToJpegFile(file: File, maxWidth = 1200, quality = 0.8): Promise<File> {
  const blob = await compressImage(file, maxWidth, quality);
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}
