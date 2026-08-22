import { useEffect, useState } from 'react';

interface PostImageProps {
  src?: string;
  alt: string;
  className?: string;
}

// Post image with a graceful fallback: if the URL is missing or the fetch
// fails (deleted object, storage outage, malformed URL), show a styled
// placeholder instead of the browser's broken-image icon.
export default function PostImage({ src, alt, className = '' }: PostImageProps) {
  const [failed, setFailed] = useState(false);

  // A new src deserves a fresh attempt (e.g. list re-renders reuse the component)
  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) {
    return (
      <div
        className={`bg-[var(--bg-secondary)] flex flex-col items-center justify-center gap-1 overflow-hidden ${className}`}
        role="img"
        aria-label={`${alt} (image unavailable)`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth="1.5"
          stroke="currentColor"
          className="size-6 text-[var(--text)] opacity-40 shrink-0"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Z"
          />
        </svg>
        <span className="text-xs text-[var(--text)] opacity-60 px-2 text-center">
          Image unavailable
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
