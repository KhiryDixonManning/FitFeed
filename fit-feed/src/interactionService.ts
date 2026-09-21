import {
  collection, deleteDoc, doc, getDoc, getDocs, increment, limit, orderBy, query,
  runTransaction, serverTimestamp, setDoc, writeBatch,
} from 'firebase/firestore';
import { db, auth } from '../firebase';

// Recommendation signals and likes.
//
// Everything here writes only into the caller's own subtree or their own like
// document, which is exactly what the security rules permit. Nothing about
// the device, browser or session is recorded - these are taste signals, not
// analytics.

export const INTERACTION_SCHEMA_VERSION = 1;

export type InteractionType = 'impression' | 'view' | 'more_like_this' | 'not_interested';
export type DwellBucket = 'short' | 'meaningful' | 'long';

/** Remember what this tab has already reported, so a re-render is not a signal. */
const sessionSent = new Set<string>();

function sessionKey(type: InteractionType, postId: string) {
  return `${type}:${postId}`;
}

/**
 * The marker the backend uses to decide a cached taste vector is stale.
 *
 * Every taste-relevant mutation must move it, and the only way to guarantee
 * that is to make the bump part of the SAME atomic write as the mutation -
 * see `stageTasteBump`. A separate follow-up write is something a future
 * refactor can drop without any test noticing.
 */
export const TASTE_STATE_COLLECTION = 'userTasteState';

export function tasteStateRef(uid: string) {
  return doc(db, TASTE_STATE_COLLECTION, uid);
}

/** The payload that advances the marker by exactly one. */
export function tasteBumpPayload() {
  return { generation: increment(1), updatedAt: serverTimestamp() };
}

/**
 * Stage the bump into a batch or transaction the caller is already building,
 * so the mutation and the invalidation commit together or not at all.
 */
export function stageTasteBump(
  writer: { set: (ref: ReturnType<typeof tasteStateRef>, data: object, options: object) => unknown },
  uid: string
): void {
  writer.set(tasteStateRef(uid), tasteBumpPayload(), { merge: true });
}

/**
 * Standalone bump, for the rare caller with nothing to batch it into.
 * Prefer `stageTasteBump`.
 */
export async function bumpTasteGeneration(uid: string): Promise<void> {
  try {
    await setDoc(tasteStateRef(uid), tasteBumpPayload(), { merge: true });
  } catch (error) {
    // A missed bump only delays personalisation; never break the action.
    console.warn('[taste] Could not bump generation:', error);
  }
}

/**
 * Record a signal. Idempotent: the document id is derived from
 * (type, postId), so repeated calls overwrite one document rather than
 * accumulating. Passive signals are additionally deduplicated per tab.
 */
export async function recordSignal(
  type: InteractionType,
  postId: string,
  options: { value?: DwellBucket; bumpTaste?: boolean } = {}
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !postId) return;

  const key = sessionKey(type, postId);
  if ((type === 'impression' || type === 'view') && sessionSent.has(key)) return;
  sessionSent.add(key);

  const payload: Record<string, unknown> = {
    postId,
    type,
    createdAt: new Date().toISOString(),
    schemaVersion: INTERACTION_SCHEMA_VERSION,
  };
  if (type === 'view' && options.value) payload.value = options.value;

  try {
    const userRef = doc(db, 'users', user.uid);
    const batch = writeBatch(db);
    batch.set(doc(collection(userRef, 'interactions'), `${type}_${postId}`), payload);

    // More-like-this and not-interested are mutually exclusive.
    const opposite: Partial<Record<InteractionType, InteractionType>> = {
      more_like_this: 'not_interested',
      not_interested: 'more_like_this',
    };
    const clear = opposite[type];
    if (clear) {
      batch.delete(doc(collection(userRef, 'interactions'), `${clear}_${postId}`));
    }
    // Explicit feedback invalidates the cached taste vector, in the same
    // batch: the signal and its invalidation are one commit.
    if (options.bumpTaste) stageTasteBump(batch, user.uid);
    await batch.commit();
  } catch (error) {
    console.warn('[interactions] Could not record signal:', error);
    sessionSent.delete(key);
  }
}

export const recordImpression = (postId: string) => recordSignal('impression', postId);
export const recordView = (postId: string, value: DwellBucket = 'meaningful') =>
  recordSignal('view', postId, { value });
export const recordMoreLikeThis = (postId: string) =>
  recordSignal('more_like_this', postId, { bumpTaste: true });
export const recordNotInterested = (postId: string) =>
  recordSignal('not_interested', postId, { bumpTaste: true });

// --------------------------------------------------------------------- likes

/**
 * Toggle a like.
 *
 * The like lives at posts/{postId}/likes/{uid} and the counter on the post
 * moves in the same transaction, which is what the rules verify: the counter
 * may only step by one, and only alongside the caller's own like document
 * appearing or disappearing. Reading inside the transaction also makes the
 * operation idempotent - a double-tap cannot produce two likes.
 *
 * Returns the resulting like state.
 */
export async function toggleLikeTransactional(postId: string, uid: string): Promise<boolean> {
  const postRef = doc(db, 'posts', postId);
  const likeRef = doc(collection(postRef, 'likes'), uid);

  return runTransaction(db, async (transaction) => {
    const [postSnap, likeSnap] = await Promise.all([
      transaction.get(postRef),
      transaction.get(likeRef),
    ]);
    if (!postSnap.exists()) return false;

    // Liking and unliking both change what this user's taste is built from,
    // so the marker moves inside the same transaction.
    stageTasteBump(transaction, uid);

    if (likeSnap.exists()) {
      transaction.delete(likeRef);
      transaction.update(postRef, { likesCount: increment(-1) });
      return false;
    }

    transaction.set(likeRef, { uid, createdAt: new Date().toISOString() });
    transaction.update(postRef, { likesCount: increment(1) });
    return true;
  });
}

/** Whether the current user has liked a post (single document read). */
export async function hasLiked(postId: string, uid: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(collection(doc(db, 'posts', postId), 'likes'), uid));
    return snap.exists();
  } catch {
    return false;
  }
}

/**
 * Which of these posts the user has liked.
 *
 * Likes are no longer an array on the post, so a page that renders its own
 * posts (a profile grid, a detail view) asks for the viewer's like documents
 * directly. That is one small read per post rather than a collection-group
 * scan of every like the user has ever left, and it is capped so a large
 * grid cannot turn into an unbounded fan-out.
 */
const MAX_LIKE_LOOKUPS = 60;

export async function getLikedPostIds(uid: string, postIds: string[]): Promise<Set<string>> {
  if (!uid || postIds.length === 0) return new Set();

  const wanted = Array.from(new Set(postIds)).slice(0, MAX_LIKE_LOOKUPS);
  const results = await Promise.all(
    wanted.map(async (postId) => {
      try {
        const snap = await getDoc(doc(collection(doc(db, 'posts', postId), 'likes'), uid));
        return snap.exists() ? postId : null;
      } catch {
        return null;
      }
    })
  );
  return new Set(results.filter((id): id is string => id !== null));
}

/**
 * Who liked a post, newest first and bounded.
 *
 * The "liked by" list used to read an array that every client carried in
 * full; it is now a query with an explicit limit, so the cost of opening a
 * viral post's detail page no longer grows with its like count.
 */
export async function getLikerIds(postId: string, max = 20): Promise<string[]> {
  try {
    const snap = await getDocs(
      query(collection(doc(db, 'posts', postId), 'likes'), orderBy('createdAt', 'desc'), limit(max))
    );
    return snap.docs.map((d) => d.id);
  } catch (error) {
    console.warn('[likes] Could not read likers:', error);
    return [];
  }
}

/** Clear per-tab dedup state, e.g. on sign-out. */
export function resetInteractionSession(): void {
  sessionSent.clear();
}

/** Remove a like document when its post is deleted (best effort). */
export async function deleteOwnLike(postId: string, uid: string): Promise<void> {
  try {
    await deleteDoc(doc(collection(doc(db, 'posts', postId), 'likes'), uid));
  } catch {
    /* the post delete already removed it, or it never existed */
  }
}
