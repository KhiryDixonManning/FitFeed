import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, doc, getDoc, getDocs, increment, runTransaction,
  setDoc, updateDoc, writeBatch,
} from 'firebase/firestore';
import { ALICE, ALICE_EMAIL, BOB, BOB_EMAIL, asUser, makeTestEnv, postDoc } from './setup';

// Phase 8 moves likes into posts/{postId}/likes/{uid}; Phase 7 adds private
// interaction signals. Both must hold up to the same adversarial standard as
// the counter suite.

let env: RulesTestEnvironment;
const CAROL = 'carol_uid';

beforeAll(async () => { env = await makeTestEnv(); });
afterAll(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE));
  });
});

async function readPost() {
  let data: Record<string, unknown> = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    data = ((await getDoc(doc(ctx.firestore(), 'posts/post1'))).data() ?? {}) as Record<string, unknown>;
  });
  return data;
}

/** The like path the app uses: like document + counter in one transaction. */
function likeTransaction(db: ReturnType<RulesTestEnvironment['authenticatedContext']>['firestore'] extends () => infer T ? T : never, uid: string) {
  const postRef = doc(db as never, 'posts/post1');
  const likeRef = doc(collection(postRef, 'likes'), uid);
  return runTransaction(db as never, async (tx) => {
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

describe('likes: the happy path', () => {
  it('a user can like and unlike, with the counter tracking', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(likeTransaction(db, BOB));
    expect((await readPost()).likesCount).toBe(1);

    await assertSucceeds(likeTransaction(db, BOB));
    expect((await readPost()).likesCount).toBe(0);
  });

  it('two users can like the same post independently', async () => {
    await assertSucceeds(likeTransaction(asUser(env, BOB, BOB_EMAIL).firestore(), BOB));
    await assertSucceeds(likeTransaction(asUser(env, CAROL, 'c@example.com').firestore(), CAROL));
    expect((await readPost()).likesCount).toBe(2);
  });

  it('unlike is idempotent at the schema level', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    // Deleting a like that is not there is allowed but changes nothing.
    await assertSucceeds(deleteDoc(doc(collection(doc(db, 'posts/post1'), 'likes'), BOB)));
    expect((await readPost()).likesCount ?? 0).toBe(0);
  });
});

describe('likes: adversarial', () => {
  it('the counter cannot move without a like document', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1) }));
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: 9999 }));
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(-1) }));
  });

  it('a like document alone cannot inflate the counter by more than one', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const postRef = doc(db, 'posts/post1');
    const batch = writeBatch(db);
    batch.set(doc(collection(postRef, 'likes'), BOB), { uid: BOB, createdAt: 'x' });
    batch.update(postRef, { likesCount: increment(25) });
    await assertFails(batch.commit());
  });

  it('a user cannot create a like document for someone else', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const postRef = doc(db, 'posts/post1');
    await assertFails(
      setDoc(doc(collection(postRef, 'likes'), CAROL), { uid: CAROL, createdAt: 'x' })
    );
  });

  it('a user cannot forge the uid field inside their own like', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const postRef = doc(db, 'posts/post1');
    await assertFails(
      setDoc(doc(collection(postRef, 'likes'), BOB), { uid: CAROL, createdAt: 'x' })
    );
  });

  it('a user cannot delete another user like', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const postRef = doc(ctx.firestore(), 'posts/post1');
      await setDoc(doc(collection(postRef, 'likes'), CAROL), { uid: CAROL, createdAt: 'x' });
    });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(deleteDoc(doc(collection(doc(db, 'posts/post1'), 'likes'), CAROL)));
  });

  it('deleting someone else like cannot drive the counter down', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const postRef = doc(ctx.firestore(), 'posts/post1');
      await setDoc(postRef, postDoc(ALICE, { likesCount: 1 }));
      await setDoc(doc(collection(postRef, 'likes'), CAROL), { uid: CAROL, createdAt: 'x' });
    });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const postRef = doc(db, 'posts/post1');
    const batch = writeBatch(db);
    batch.delete(doc(collection(postRef, 'likes'), CAROL));
    batch.update(postRef, { likesCount: increment(-1) });
    await assertFails(batch.commit());
  });

  it('liking twice cannot double count', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(likeTransaction(db, BOB));
    // The like document already exists, so a second +1 has nothing to pair with.
    const postRef = doc(db, 'posts/post1');
    const batch = writeBatch(db);
    batch.set(doc(collection(postRef, 'likes'), BOB), { uid: BOB, createdAt: 'y' });
    batch.update(postRef, { likesCount: increment(1) });
    await assertFails(batch.commit());
    expect((await readPost()).likesCount).toBe(1);
  });

  it('a like document cannot be edited after creation', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(likeTransaction(db, BOB));
    await assertFails(
      updateDoc(doc(collection(doc(db, 'posts/post1'), 'likes'), BOB), { uid: CAROL })
    );
  });

  it('the legacy likedBy array is no longer writable', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likedBy: [BOB], likesCount: increment(1) })
    );
  });

  it('the counter cannot be smuggled into a content edit', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { content: 'new', likesCount: increment(1) })
    );
  });
});

describe('interaction signals', () => {
  const signal = (type: string, postId = 'post1', extra: Record<string, unknown> = {}) => ({
    postId, type, createdAt: new Date().toISOString(), schemaVersion: 1, ...extra,
  });

  it('a user can record their own signals', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    for (const type of ['impression', 'view', 'more_like_this', 'not_interested']) {
      await assertSucceeds(
        setDoc(doc(db, `users/${BOB}/interactions/${type}_post1`), signal(type))
      );
    }
  });

  it('the document id must match the signal it claims', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    // A mismatched id would allow unlimited impressions for one post.
    await assertFails(
      setDoc(doc(db, `users/${BOB}/interactions/impression_post1_again`), signal('impression'))
    );
    await assertFails(
      setDoc(doc(db, `users/${BOB}/interactions/view_post1`), signal('impression'))
    );
  });

  it('unknown signal types are refused', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, `users/${BOB}/interactions/purchase_post1`), signal('purchase'))
    );
  });

  it('a user cannot write signals into another user subtree', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/interactions/impression_post1`), signal('impression'))
    );
  });

  it('signals stay private to their owner', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${ALICE}/interactions/not_interested_post1`),
        signal('not_interested'));
    });
    const bob = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDoc(doc(bob, `users/${ALICE}/interactions/not_interested_post1`)));
    await assertFails(getDocs(collection(bob, `users/${ALICE}/interactions`)));

    const alice = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(getDocs(collection(alice, `users/${ALICE}/interactions`)));
  });

  it('dwell is limited to coarse buckets', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, `users/${BOB}/interactions/view_post1`), signal('view', 'post1', { value: 'meaningful' }))
    );
    // No precise durations, and no invented buckets.
    await assertFails(
      setDoc(doc(db, `users/${BOB}/interactions/view_post1`), signal('view', 'post1', { value: 42_000 }))
    );
    await assertFails(
      setDoc(doc(db, `users/${BOB}/interactions/view_post1`), signal('view', 'post1', { value: 'forever' }))
    );
  });

  it('extra fields are refused', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    for (const extra of [
      { userAgent: 'Mozilla/5.0' },
      { ipAddress: '10.0.0.1' },
      { weight: 999 },
      { sessionId: 'abc' },
    ]) {
      await assertFails(
        setDoc(doc(db, `users/${BOB}/interactions/impression_post1`),
          signal('impression', 'post1', extra))
      );
    }
  });

  it('a signal cannot alter the post it refers to', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, `users/${BOB}/interactions/not_interested_post1`), signal('not_interested'))
    );
    // Not interested is feedback, not moderation: the post is untouched.
    const stored = await readPost();
    expect(stored.likesCount).toBe(0);
    expect(stored.commentsCount).toBe(0);
  });
});

describe('taste state marker', () => {
  it('a user can bump their own generation', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, `userTasteState/${BOB}`), { generation: increment(1) }, { merge: true })
    );
  });

  it('a user cannot bump someone else generation', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, `userTasteState/${ALICE}`), { generation: increment(1) }, { merge: true })
    );
  });

  it('the marker cannot carry arbitrary fields', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, `userTasteState/${BOB}`), { generation: 1, isAdmin: true })
    );
  });

  it('another user cannot read it', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDoc(doc(db, `userTasteState/${ALICE}`)));
  });
});

describe('analysis jobs', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'analysisJobs/post1'), {
        postId: 'post1', uid: ALICE, status: 'queued', attempts: 0,
      });
    });
  });

  it('the post author can read their own job status', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(getDoc(doc(db, 'analysisJobs/post1')));
  });

  it('another user cannot read it', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDoc(doc(db, 'analysisJobs/post1')));
  });

  it('no client may write job state', async () => {
    const alice = asUser(env, ALICE, ALICE_EMAIL).firestore();
    // Not even the owner: attempts and status are a spend budget.
    await assertFails(updateDoc(doc(alice, 'analysisJobs/post1'), { attempts: 0 }));
    await assertFails(updateDoc(doc(alice, 'analysisJobs/post1'), { status: 'queued' }));
    await assertFails(deleteDoc(doc(alice, 'analysisJobs/post1')));
    await assertFails(setDoc(doc(alice, 'analysisJobs/post2'), { postId: 'post2' }));
  });
});
