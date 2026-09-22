import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  arrayRemove, arrayUnion, collection, doc, getDoc, increment,
  runTransaction, setDoc, updateDoc, writeBatch,
} from 'firebase/firestore';
import {
  ALICE, ALICE_EMAIL, BOB, BOB_EMAIL, asUser, commentDoc, makeTestEnv, postDoc,
} from './setup';

// Adversarial suite for the engagement counters.
//
// Each block states an invariant and then tries to break it the way an
// attacker with a browser console would: arbitrary field writes, transforms
// with the wrong magnitude, decoupling the counter from the membership array,
// reusing another user's identity, and racing concurrent writes.

let env: RulesTestEnvironment;
const CAROL = 'carol_uid';

beforeAll(async () => {
  env = await makeTestEnv();
});

afterAll(async () => {
  await env.cleanup();
});

async function seedPost(overrides: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE, overrides));
  });
}

/**
 * The like path the app actually uses since Phase 8: a like document at
 * posts/{id}/likes/{uid} written in the same transaction as the counter.
 * The legacy likedBy array is no longer writable by any client.
 */
function likeTransaction(db: never, uid: string) {
  const postRef = doc(db, 'posts/post1');
  const likeRef = doc(collection(postRef, 'likes'), uid);
  return runTransaction(db, async (tx) => {
    const likeSnap = await tx.get(likeRef);
    if (likeSnap.exists()) {
      tx.delete(likeRef);
      tx.update(postRef, { likesCount: increment(-1) });
      return false;
    }
    tx.set(likeRef, { uid, createdAt: new Date().toISOString() });
    tx.update(postRef, { likesCount: increment(1) });
    return true;
  });
}

async function readLikeIds(): Promise<string[]> {
  const { getDocs } = await import('firebase/firestore');
  let ids: string[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDocs(collection(doc(ctx.firestore(), 'posts/post1'), 'likes'));
    ids = snap.docs.map(d => d.id).sort();
  });
  return ids;
}

async function readPost() {
  let data: Record<string, unknown> = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'posts/post1'));
    data = (snap.data() ?? {}) as Record<string, unknown>;
  });
  return data;
}

beforeEach(async () => {
  await env.clearFirestore();
  await seedPost();
});

// ---------------------------------------------------------------------------
describe('INVARIANT: likesCount cannot be arbitrarily incremented', () => {
  it('rejects a raw absolute value', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: 100000 }));
  });

  it('rejects a large increment transform', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(500) }));
  });

  it('rejects +1 with no membership change', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1) }));
  });

  it('rejects +2 even when the array grows by one', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(2), likedBy: arrayUnion(BOB) })
    );
  });

  it('rejects a second like for a post already liked', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(likeTransaction(db as never, BOB));

    // The like document already exists, so a further +1 has nothing to pair
    // with and the rules refuse it.
    const postRef = doc(db, 'posts/post1');
    const batch = writeBatch(db);
    batch.set(doc(collection(postRef, 'likes'), BOB), { uid: BOB, createdAt: 'again' });
    batch.update(postRef, { likesCount: increment(1) });
    await assertFails(batch.commit());

    expect((await readPost()).likesCount).toBe(1);
    expect(await readLikeIds()).toEqual([BOB]);
  });

  it('rejects a float increment used to dodge the +1 check', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1.5), likedBy: arrayUnion(BOB) })
    );
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: likesCount cannot go below zero', () => {
  it('rejects a negative absolute value', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: -5 }));
  });

  it('rejects unliking a post the user has not liked', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(-1), likedBy: arrayRemove(BOB) })
    );
  });

  it('rejects an unlike that would drive a drifted counter negative', async () => {
    // Pre-existing drift: membership says Bob liked it, counter says zero.
    await seedPost({ likesCount: 0, likedBy: [BOB] });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(-1), likedBy: arrayRemove(BOB) })
    );
    expect((await readPost()).likesCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: likesCount and the like documents stay consistent', () => {
  it('rejects changing the counter alone', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1) }));
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(-1) }));
  });

  it('rejects writing the legacy array at all', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likedBy: arrayUnion(BOB) }));
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likedBy: [BOB], likesCount: increment(1) })
    );
  });

  it('rejects a like document created without moving the counter in step', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const postRef = doc(db, 'posts/post1');
    const batch = writeBatch(db);
    batch.set(doc(collection(postRef, 'likes'), BOB), { uid: BOB, createdAt: 'x' });
    batch.update(postRef, { likesCount: increment(3) });
    await assertFails(batch.commit());
  });

  it('keeps count and documents in step across a like then unlike', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(likeTransaction(db as never, BOB));
    expect((await readPost()).likesCount).toBe(1);
    expect(await readLikeIds()).toEqual([BOB]);

    await assertSucceeds(likeTransaction(db as never, BOB));
    expect((await readPost()).likesCount).toBe(0);
    expect(await readLikeIds()).toEqual([]);
  });

  it('the post document never accumulates an unbounded liker list', async () => {
    for (const uid of [BOB, CAROL, 'dave_uid']) {
      await assertSucceeds(likeTransaction(asUser(env, uid, `${uid}@example.com`).firestore() as never, uid));
    }
    const post = await readPost();
    expect(post.likesCount).toBe(3);
    // Likes live in a subcollection; nothing grew on the post itself.
    expect(post.likedBy).toEqual([]);
    expect(await readLikeIds()).toEqual([BOB, CAROL, 'dave_uid'].sort());
  });
});

describe('INVARIANT: a user cannot touch another user interaction state', () => {
  it('rejects liking on behalf of someone else', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1), likedBy: arrayUnion(CAROL) })
    );
  });

  it('rejects removing another user like', async () => {
    await seedPost({ likesCount: 1, likedBy: [CAROL] });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(-1), likedBy: arrayRemove(CAROL) })
    );
  });

  it('rejects adding self while evicting another user in one write', async () => {
    await seedPost({ likesCount: 1, likedBy: [CAROL] });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: 1, likedBy: [BOB] })
    );
  });

  it('rejects wiping the membership array', async () => {
    await seedPost({ likesCount: 3, likedBy: [ALICE, BOB, CAROL] });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: 0, likedBy: [] }));
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: commentsCount only moves with a real comment', () => {
  it('rejects a bare increment with no comment attached', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { commentsCount: increment(1) }));
  });

  it('rejects a bare decrement', async () => {
    await seedPost({ commentsCount: 5 });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { commentsCount: increment(-1) }));
  });

  it('rejects an absolute counter value', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { commentsCount: 9999 }));
  });

  it('rejects a large increment', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { commentsCount: increment(40) }));
  });

  it('accepts an increment batched with a genuine new comment', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    const commentRef = doc(collection(db, 'comments'));
    batch.set(commentRef, commentDoc(BOB, BOB_EMAIL));
    batch.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertSucceeds(batch.commit());
    expect((await readPost()).commentsCount).toBe(1);
  });

  it('rejects citing a comment that already existed', async () => {
    // Create one legitimate comment...
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const first = writeBatch(db);
    const commentRef = doc(collection(db, 'comments'));
    first.set(commentRef, commentDoc(BOB, BOB_EMAIL));
    first.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertSucceeds(first.commit());

    // ...then try to bump the counter again pointing at that same comment.
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        commentsCount: increment(1),
        lastCommentId: commentRef.id,
      })
    );
    expect((await readPost()).commentsCount).toBe(1);
  });

  it('rejects citing a comment that belongs to a different post', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'posts/post2'), postDoc(ALICE));
    });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    const commentRef = doc(collection(db, 'comments'));
    batch.set(commentRef, commentDoc(BOB, BOB_EMAIL, 'post2'));
    // Comment is on post2, but the counter bump targets post1.
    batch.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertFails(batch.commit());
  });

  it('rejects citing a nonexistent comment id', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        commentsCount: increment(1),
        lastCommentId: 'no_such_comment',
      })
    );
  });

  it('rejects a comment authored by someone else driving the counter', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    const commentRef = doc(collection(db, 'comments'));
    // Bob writes a comment claiming Carol wrote it - the comment rule refuses,
    // so the whole batch (counter included) fails.
    batch.set(commentRef, commentDoc(CAROL, 'carol@example.com'));
    batch.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertFails(batch.commit());
    expect((await readPost()).commentsCount).toBe(0);
  });

  it('accepts a decrement batched with a genuine comment deletion', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const add = writeBatch(db);
    const commentRef = doc(collection(db, 'comments'));
    add.set(commentRef, commentDoc(BOB, BOB_EMAIL));
    add.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertSucceeds(add.commit());

    const remove = writeBatch(db);
    remove.delete(commentRef);
    remove.update(doc(db, 'posts/post1'), {
      commentsCount: increment(-1),
      lastCommentId: commentRef.id,
    });
    await assertSucceeds(remove.commit());
    expect((await readPost()).commentsCount).toBe(0);
  });

  it('rejects a decrement when the cited comment is left in place', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const add = writeBatch(db);
    const commentRef = doc(collection(db, 'comments'));
    add.set(commentRef, commentDoc(BOB, BOB_EMAIL));
    add.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertSucceeds(add.commit());

    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        commentsCount: increment(-1),
        lastCommentId: commentRef.id,
      })
    );
    expect((await readPost()).commentsCount).toBe(1);
  });

  it('rejects deleting someone else comment to drive the counter down', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'comments/c_carol'), {
        ...commentDoc(CAROL, 'carol@example.com'),
      });
      await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE, { commentsCount: 1 }));
    });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    batch.delete(doc(db, 'comments/c_carol'));
    batch.update(doc(db, 'posts/post1'), {
      commentsCount: increment(-1),
      lastCommentId: 'c_carol',
    });
    await assertFails(batch.commit());
  });

  it('rejects a counter bump smuggled alongside a content edit', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { content: 'new caption', commentsCount: increment(1) })
    );
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: concurrency does not cause counter drift', () => {
  it('two different users liking at once produces exactly two likes', async () => {
    const bob = asUser(env, BOB, BOB_EMAIL).firestore();
    const carol = asUser(env, CAROL, 'carol@example.com').firestore();

    await Promise.all([
      likeTransaction(bob as never, BOB),
      likeTransaction(carol as never, CAROL),
    ]);

    expect((await readPost()).likesCount).toBe(2);
    expect(await readLikeIds()).toEqual([BOB, CAROL].sort());
  });

  it('one user double-clicking cannot register two likes', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await Promise.allSettled([
      likeTransaction(db as never, BOB),
      likeTransaction(db as never, BOB),
    ]);

    // Whatever the interleaving, the document set and the counter agree.
    const ids = await readLikeIds();
    const post = await readPost();
    expect(ids.length).toBeLessThanOrEqual(1);
    expect(post.likesCount).toBe(ids.length);
  });

  it('a like and a comment landing together both apply cleanly', async () => {
    const bob = asUser(env, BOB, BOB_EMAIL).firestore();
    const carol = asUser(env, CAROL, 'carol@example.com').firestore();

    const commentRef = doc(collection(carol, 'comments'));
    const commentBatch = writeBatch(carol);
    commentBatch.set(commentRef, commentDoc(CAROL, 'carol@example.com'));
    commentBatch.update(doc(carol, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });

    await Promise.all([likeTransaction(bob as never, BOB), commentBatch.commit()]);

    const post = await readPost();
    expect(post.likesCount).toBe(1);
    expect(post.commentsCount).toBe(1);
    expect(await readLikeIds()).toEqual([BOB]);
  });

  it('parallel comment batches each need their own new comment', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();

    const makeBatch = () => {
      const ref = doc(collection(db, 'comments'));
      const batch = writeBatch(db);
      batch.set(ref, commentDoc(BOB, BOB_EMAIL));
      batch.update(doc(db, 'posts/post1'), {
        commentsCount: increment(1),
        lastCommentId: ref.id,
      });
      return batch.commit();
    };

    await Promise.all([makeBatch(), makeBatch(), makeBatch()]);
    expect((await readPost()).commentsCount).toBe(3);
  });
});
