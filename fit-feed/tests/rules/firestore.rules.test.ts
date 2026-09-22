import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, increment, query,
  setDoc, updateDoc, where, writeBatch, arrayUnion,
} from 'firebase/firestore';
import {
  ALICE, ALICE_EMAIL, BOB, BOB_EMAIL, asUser, commentDoc, makeTestEnv, postDoc, storageUrlFor,
} from './setup';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await makeTestEnv();
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  // Seed a post owned by Alice, bypassing rules.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'posts/post1'), postDoc(ALICE));
    await setDoc(doc(db, 'comments/c_alice'), commentDoc(ALICE, ALICE_EMAIL));
    await setDoc(doc(db, 'comments/c_bob'), commentDoc(BOB, BOB_EMAIL));
  });
});

describe('anonymous access', () => {
  it('cannot read posts', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'posts/post1')));
  });

  it('cannot create posts', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(addDoc(collection(db, 'posts'), postDoc(ALICE)));
  });

  it('cannot write to another collection', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'users/alice_uid'), { uid: ALICE }));
    await assertFails(setDoc(doc(db, 'saves/alice_uid_post1'), { uid: ALICE, postId: 'post1' }));
  });
});

describe('posts', () => {
  it('an authenticated user can read posts', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(getDoc(doc(db, 'posts/post1')));
  });

  it('a user can create a post as themselves', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(addDoc(collection(db, 'posts'), postDoc(ALICE)));
  });

  it('a user CANNOT create a post pretending to be someone else', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(addDoc(collection(db, 'posts'), postDoc(BOB)));
  });

  it('a post cannot be created with engagement already on it', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      addDoc(collection(db, 'posts'), postDoc(ALICE, { likesCount: 500 }))
    );
    await assertFails(
      addDoc(collection(db, 'posts'), postDoc(ALICE, { likedBy: [BOB] }))
    );
  });

  it('a post cannot claim another user uploaded image', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      addDoc(collection(db, 'posts'), postDoc(ALICE, { imageUrl: storageUrlFor(BOB) }))
    );
  });

  it('a post cannot be created with an off-bucket image url', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      addDoc(collection(db, 'posts'), postDoc(ALICE, { imageUrl: 'https://evil.example.com/x.jpg' }))
    );
  });

  it('a post cannot be created claiming analysis is already complete', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      addDoc(collection(db, 'posts'), postDoc(ALICE, { analysisStatus: 'complete' }))
    );
  });

  it('User A CANNOT modify User B post content', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { content: 'defaced' }));
  });

  it('the author CAN edit their own caption', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(updateDoc(doc(db, 'posts/post1'), { content: 'edited caption' }));
  });

  it('the author CANNOT reassign authorId', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { authorId: BOB }));
  });

  it('nobody can write AI analysis fields from the client', async () => {
    const alice = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(updateDoc(doc(alice, 'posts/post1'), { analyzed: true }));
    await assertFails(updateDoc(doc(alice, 'posts/post1'), { outfitName: 'Fake Name' }));
    await assertFails(updateDoc(doc(alice, 'posts/post1'), { analysisStatus: 'complete' }));
    await assertFails(
      updateDoc(doc(alice, 'posts/post1'), { palette: [{ hex: '#000000', name: 'x', percentage: 1 }] })
    );
  });

  it('likes are covered by likes.interactions.test.ts', async () => {
    // Phase 8 moved likes to posts/{id}/likes/{uid}; the array path is gone.
    // Only the refusal of the legacy shape is asserted here.
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1), likedBy: arrayUnion(BOB) })
    );
  });

  it('a user cannot inflate the like counter', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: 9999 }));
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(50) }));
  });

  it('a user cannot like on behalf of someone else', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1), likedBy: arrayUnion(ALICE) })
    );
  });

  it('the comment counter cannot move on its own', async () => {
    // Full adversarial coverage lives in counters.attack.test.ts; the counter
    // is only writable alongside the comment it accounts for.
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { commentsCount: increment(1) }));
    await assertFails(updateDoc(doc(db, 'posts/post1'), { commentsCount: increment(25) }));
  });

  it('only the author can delete a post', async () => {
    const bob = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(deleteDoc(doc(bob, 'posts/post1')));
    const alice = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(deleteDoc(doc(alice, 'posts/post1')));
  });
});

describe('comments', () => {
  it('a user can comment as themselves, atomically with the counter', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    const commentRef = doc(collection(db, 'comments'));
    batch.set(commentRef, commentDoc(BOB, BOB_EMAIL));
    batch.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertSucceeds(batch.commit());
  });

  it('User A CANNOT create a comment pretending to be User B', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(addDoc(collection(db, 'comments'), commentDoc(BOB, BOB_EMAIL)));
  });

  it('a user cannot spoof the displayed author email', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      addDoc(collection(db, 'comments'), commentDoc(ALICE, 'someone.else@example.com'))
    );
  });

  it('empty and oversized comments are refused', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      addDoc(collection(db, 'comments'), { ...commentDoc(ALICE, ALICE_EMAIL), content: '' })
    );
    await assertFails(
      addDoc(collection(db, 'comments'), { ...commentDoc(ALICE, ALICE_EMAIL), content: 'x'.repeat(1001) })
    );
  });

  it('User A CANNOT delete User B comment', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(deleteDoc(doc(db, 'comments/c_alice')));
  });

  it('a user CAN delete their own comment', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(deleteDoc(doc(db, 'comments/c_bob')));
  });

  it('a post author CAN moderate comments on their own post', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(deleteDoc(doc(db, 'comments/c_bob')));
  });

  it('comments cannot be edited', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'comments/c_alice'), { content: 'changed' }));
  });
});

describe('userPreferences', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'userPreferences/alice_uid'), { streetwear: 5 });
    });
  });

  it('the owner can read and write their own preferences', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(getDoc(doc(db, 'userPreferences/alice_uid')));
    await assertSucceeds(setDoc(doc(db, 'userPreferences/alice_uid'), { streetwear: 6 }));
  });

  it('another user can neither read nor write them', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDoc(doc(db, 'userPreferences/alice_uid')));
    await assertFails(setDoc(doc(db, 'userPreferences/alice_uid'), { streetwear: 999 }));
  });
});

// users + publicProfiles are covered in profiles.rules.test.ts, which owns
// the private/public account split.

describe('follows', () => {
  it('a user can follow someone as themselves', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, `follows/${ALICE}_${BOB}`), {
        followerId: ALICE, followingId: BOB, createdAt: new Date().toISOString(),
      })
    );
  });

  it('a user cannot spoof followerId', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, `follows/${BOB}_${ALICE}`), {
        followerId: BOB, followingId: ALICE, createdAt: new Date().toISOString(),
      })
    );
  });

  it('the document id must match the relationship it claims', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'follows/totally_unrelated_id'), {
        followerId: ALICE, followingId: BOB, createdAt: new Date().toISOString(),
      })
    );
  });

  it('a user can only unfollow their own follow edge', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `follows/${ALICE}_${BOB}`), {
        followerId: ALICE, followingId: BOB, createdAt: new Date().toISOString(),
      });
    });
    const bob = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(deleteDoc(doc(bob, `follows/${ALICE}_${BOB}`)));
    const alice = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(deleteDoc(doc(alice, `follows/${ALICE}_${BOB}`)));
  });
});

describe('saves', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `saves/${ALICE}_post1`), {
        uid: ALICE, postId: 'post1', createdAt: new Date().toISOString(),
      });
    });
  });

  it('a user can save a post for themselves', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, `saves/${BOB}_post1`), {
        uid: BOB, postId: 'post1', createdAt: new Date().toISOString(),
      })
    );
  });

  it('saves stay private to their owner', async () => {
    const bob = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDoc(doc(bob, `saves/${ALICE}_post1`)));
    await assertFails(
      getDocs(query(collection(bob, 'saves'), where('uid', '==', ALICE)))
    );
    const alice = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(
      getDocs(query(collection(alice, 'saves'), where('uid', '==', ALICE)))
    );
  });

  it('a user cannot save on behalf of another user', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, `saves/${ALICE}_post2`), {
        uid: ALICE, postId: 'post2', createdAt: new Date().toISOString(),
      })
    );
  });

  it('a user cannot delete another user save', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(deleteDoc(doc(db, `saves/${ALICE}_post1`)));
  });
});
