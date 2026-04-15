import { collection, addDoc, getDocs, query, where, deleteDoc, doc, updateDoc, increment } from 'firebase/firestore';
import { db } from '../../firebase';

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

const DEMO_USERS = [
  { email: 'alex@fitfeed.com', uid: 'demo_user_1' },
  { email: 'jordan@fitfeed.com', uid: 'demo_user_2' },
  { email: 'riley@fitfeed.com', uid: 'demo_user_3' },
  { email: 'sam@fitfeed.com', uid: 'demo_user_4' },
  { email: 'taylor@fitfeed.com', uid: 'demo_user_5' },
  { email: 'morgan@fitfeed.com', uid: 'demo_user_6' },
  { email: 'casey@fitfeed.com', uid: 'demo_user_7' },
];

export const seedDemoComments = async (postId: string, count: number = 5): Promise<void> => {
  const shuffled = [...DEMO_COMMENTS].sort(() => Math.random() - 0.5).slice(0, count);
  for (const text of shuffled) {
    const user = DEMO_USERS[Math.floor(Math.random() * DEMO_USERS.length)];
    await addDoc(collection(db, 'comments'), {
      postId,
      authorId: user.uid,
      authorEmail: user.email,
      content: text,
      createdAt: new Date(Date.now() - Math.random() * 86400000 * 3).toISOString(),
      isDemo: true,
    });
  }
  await updateDoc(doc(db, 'posts', postId), {
    commentsCount: increment(count),
  });
  console.log(`[demoComments] Seeded ${count} comments for post ${postId}`);
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
  const postCounts: Record<string, number> = {};
  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    postCounts[data.postId] = (postCounts[data.postId] || 0) + 1;
    await deleteDoc(doc(db, 'comments', docSnap.id));
  }
  for (const [postId, count] of Object.entries(postCounts)) {
    await updateDoc(doc(db, 'posts', postId), {
      commentsCount: increment(-count),
    });
  }
  console.log(`[demoComments] Removed ${snapshot.docs.length} demo comments`);
};
