import { useEffect, useRef } from 'react';
import { recordImpression, recordView } from '../interactionService';

// Turns "was this post actually looked at" into two bounded signals.
//
// An impression is not a render: the card must be at least half on screen,
// in a visible tab, for a continuous second. A view needs a longer dwell.
// Both are reported at most once per post per tab (and at most once per post
// ever, server-side, because the document id is derived from the post).
//
// Scrolling quickly past a hundred posts therefore produces no signal, and
// leaving a tab open in the background produces none either.

const IMPRESSION_VISIBLE_RATIO = 0.5;
const IMPRESSION_DWELL_MS = 1000;
const VIEW_DWELL_MS = 5000;

export function usePostVisibility(postId: string | undefined, enabled = true) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const timersRef = useRef<{ impression?: number; view?: number }>({});

  useEffect(() => {
    const element = elementRef.current;
    if (!enabled || !postId || !element) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const clearTimers = () => {
      if (timersRef.current.impression) window.clearTimeout(timersRef.current.impression);
      if (timersRef.current.view) window.clearTimeout(timersRef.current.view);
      timersRef.current = {};
    };

    const startTimers = () => {
      if (document.visibilityState !== 'visible') return;
      if (timersRef.current.impression || timersRef.current.view) return;
      timersRef.current.impression = window.setTimeout(() => {
        recordImpression(postId);
      }, IMPRESSION_DWELL_MS);
      timersRef.current.view = window.setTimeout(() => {
        recordView(postId, 'meaningful');
      }, VIEW_DWELL_MS);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_VISIBLE_RATIO) {
          startTimers();
        } else {
          // Scrolled away before the threshold: nothing is recorded.
          clearTimers();
        }
      },
      { threshold: [IMPRESSION_VISIBLE_RATIO] }
    );

    // A backgrounded tab must not keep accruing dwell.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') clearTimers();
    };

    observer.observe(element);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearTimers();
    };
  }, [postId, enabled]);

  return elementRef;
}
