import { collection, getDocs, query, where, doc, increment, writeBatch } from 'firebase/firestore';
import { db, auth } from '../../firebase';

// Dev-only helper for populating comment threads on a local/demo database.
//
// This used to write comments under invented identities (demo_user_1, ...)
// and bump commentsCount by N in a single write. Both are now correctly
// refused by the security rules: comment authorship is bound to the verified
// auth token, and the counter may only step by one. The seeder therefore
// posts as the signed-in user, one atomic comment at a time — it exercises
// exactly the same write path a real comment takes.

const DEMO_COMMENTS = [
  "this fit is everything 🔥",
  "the color palette on this is insane",
  "where did you get those shoes??",
  "obsessed with this aesthetic",
  "this is giving exactly what it needs to give",
  "the layering here is so good",
  "ok this is my new favorite post on here",
  "you always eat with the fits fr",
  "the color blocking is *chefs kiss*",
  "i need the full outfit breakdown asap",
  "this is so your vibe honestly",
  "ok but the shoes make this whole look",
  "been looking for something like this forever",
  "the fit check was not missed",
  "this aesthetic is so well executed",
  "the drip is unmatched rn",
  "not me saving this for inspo",
  "everything about this works perfectly",
  "the fit is immaculate",
  "giving main character energy fr",
];

export const seedDemoComments = async (postId: string, count: number = 5): Promise<void> => {
  const user = auth.currentUser;
  if (!user) {
    console.warn('[demoComments] Sign in first — comments are attributed to the current user.');
    return;
  }

  const shuffled = [...DEMO_COMMENTS].sort(() => Math.random() - 0.5).slice(0, count);
  let written = 0;

  for (const text of shuffled) {
    try {
      const batch = writeBatch(db);
      const commentRef = doc(collection(db, 'comments'));
      batch.set(commentRef, {
        postId,
        authorId: user.uid,
        authorEmail: user.email ?? '',
        content: text,
        createdAt: new Date(Date.now() - Math.random() * 86400000 * 3).toISOString(),
        isDemo: true,
      });
      batch.update(doc(db, 'posts', postId), {
        commentsCount: increment(1),
        lastCommentId: commentRef.id,
      });
      await batch.commit();
      written++;
    } catch (error) {
      console.error('[demoComments] Failed to seed a comment:', error);
    }
  }

  console.log(`[demoComments] Seeded ${written} comments for post ${postId}`);
};

export const seedAllPosts = async (): Promise<void> => {
  const snapshot = await getDocs(collection(db, 'posts'));
  for (const postDoc of snapshot.docs) {
    await seedDemoComments(postDoc.id, Math.floor(Math.random() * 5) + 3);
  }
  console.log('[demoComments] All posts seeded');
};

export const removeAllDemoComments = async (): Promise<void> => {
  const q = query(collection(db, 'comments'), where('isDemo', '==', true));
  const snapshot = await getDocs(q);
  let removed = 0;

  // Delete and decrement atomically, naming the comment so the rules can
  // confirm the counter step matches a real deletion.
  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'comments', docSnap.id));
      batch.update(doc(db, 'posts', data.postId), {
        commentsCount: increment(-1),
        lastCommentId: docSnap.id,
      });
      await batch.commit();
      removed++;
    } catch (error) {
      console.error('[demoComments] Failed to remove a comment:', error);
    }
  }

  console.log(`[demoComments] Removed ${removed} demo comments`);
};
