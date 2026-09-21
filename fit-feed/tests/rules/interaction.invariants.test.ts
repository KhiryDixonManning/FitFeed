import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, doc, getDoc, increment, serverTimestamp,
  setDoc, updateDoc, writeBatch,
} from 'firebase/firestore';
import { ALICE, ALICE_EMAIL, BOB, BOB_EMAIL, asUser, makeTestEnv, postDoc } from './setup';

// The interaction / taste-invalidation model, audited invariant by invariant.
//
// These signals are the only thing standing between "the feed learns what you
// like" and "the feed can be steered, or someone else's can". Each block below
// is one property the rules must hold on their own - not because the client
// happens to be well-behaved, but because a hostile client cannot do otherwise.

let env: RulesTestEnvironment;

beforeAll(async () => { env = await makeTestEnv(); });
afterAll(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE));
    await setDoc(doc(ctx.firestore(), 'posts/post2'), postDoc(BOB));
  });
});

const signal = (postId: string, type = 'impression', extra: Record<string, unknown> = {}) => ({
  postId,
  type,
  createdAt: new Date('2026-06-01T12:00:00Z').toISOString(),
  schemaVersion: 1,
  ...extra,
});

const interactionRef = (db: unknown, uid: string, id: string) =>
  doc(collection(doc(db as never, 'users', uid), 'interactions'), id);

async function seedGeneration(uid: string, value: number) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'userTasteState', uid), {
      generation: value,
      updatedAt: new Date().toISOString(),
    });
  });
}

async function readGeneration(uid: string): Promise<unknown> {
  let value: unknown;
  await env.withSecurityRulesDisabled(async (ctx) => {
    value = (await getDoc(doc(ctx.firestore(), 'userTasteState', uid))).data()?.generation;
  });
  return value;
}

// --------------------------------------------------------- document identity

describe('INVARIANT: the document id is the (type, postId) pair', () => {
  it('accepts an id that matches its contents', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(
      setDoc(interactionRef(db, ALICE, 'impression_post1'), signal('post1'))
    );
  });

  it('rejects an id that names a different post than the payload', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_post2'), signal('post1'))
    );
  });

  it('rejects an id that names a different type than the payload', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'view_post1'), signal('post1', 'impression'))
    );
  });

  it('rejects a freely chosen id', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(setDoc(interactionRef(db, ALICE, 'anything'), signal('post1')));
    await assertFails(setDoc(interactionRef(db, ALICE, 'impression_post1_2'), signal('post1')));
  });

  it('means a post can never contribute two impressions', async () => {
    // Writing the same signal ten times is ten writes to one document, and
    // the id is the only place it could land.
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    for (let i = 0; i < 10; i++) {
      await assertSucceeds(
        setDoc(interactionRef(db, ALICE, 'impression_post1'), signal('post1'))
      );
    }
    let count = 0;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { getDocs } = await import('firebase/firestore');
      const snap = await getDocs(
        collection(doc(ctx.firestore(), 'users', ALICE), 'interactions')
      );
      count = snap.size;
    });
    expect(count).toBe(1);
  });
});

// ------------------------------------------------------------- the type enum

describe('INVARIANT: type comes from an explicit allowed set', () => {
  for (const type of ['impression', 'view', 'more_like_this', 'not_interested']) {
    it(`accepts ${type}`, async () => {
      const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
      await assertSucceeds(
        setDoc(interactionRef(db, ALICE, `${type}_post1`), signal('post1', type))
      );
    });
  }

  for (const type of ['purchase', 'click', 'IMPRESSION', '', 'more_like_this ', 'dwell']) {
    it(`rejects ${JSON.stringify(type)}`, async () => {
      const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
      await assertFails(
        setDoc(interactionRef(db, ALICE, `${type}_post1`), signal('post1', type))
      );
    });
  }

  it('rejects a non-string type', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_post1'), signal('post1', 1 as never))
    );
  });
});

// ------------------------------------------------------------ immutable keys

describe('INVARIANT: postId and type are immutable after creation', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        interactionRef(ctx.firestore(), ALICE, 'impression_post1'),
        signal('post1')
      );
    });
  });

  it('rejects repointing an existing signal at another post', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      updateDoc(interactionRef(db, ALICE, 'impression_post1'), { postId: 'post2' })
    );
  });

  it('rejects upgrading a passive signal into explicit feedback', async () => {
    // Otherwise an impression the UI recorded automatically could be turned
    // into a "more like this" the user never pressed.
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      updateDoc(interactionRef(db, ALICE, 'impression_post1'), { type: 'more_like_this' })
    );
  });

  it('allows the owner to delete their own signal', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(deleteDoc(interactionRef(db, ALICE, 'impression_post1')));
  });
});

// ----------------------------------------------------------- shape and scope

describe('INVARIANT: the payload carries nothing but the signal', () => {
  it('rejects arbitrary extra fields', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    for (const extra of [
      { userAgent: 'Mozilla/5.0' },
      { ip: '203.0.113.4' },
      { sessionId: 'abc' },
      { referrer: 'https://example.com' },
      { weight: 999 },
      { durationMs: 91234 },
      { uid: ALICE },
    ]) {
      await assertFails(
        setDoc(interactionRef(db, ALICE, 'impression_post1'), signal('post1', 'impression', extra))
      );
    }
  });

  it('rejects a missing required field', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_post1'), {
        postId: 'post1', type: 'impression', schemaVersion: 1,
      })
    );
  });

  it('rejects a dwell value outside the three buckets', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'view_post1'), signal('post1', 'view', { value: '91234' }))
    );
    await assertSucceeds(
      setDoc(interactionRef(db, ALICE, 'view_post1'), signal('post1', 'view', { value: 'long' }))
    );
  });

  it('rejects a bumped schemaVersion that the backend would not understand', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_post1'), signal('post1', 'impression', { schemaVersion: 2 }))
    );
  });
});

describe('INVARIANT: a signal must name a post that exists', () => {
  it('rejects an invented post id', async () => {
    // Without this a user could mint unlimited documents in their own
    // subtree by inventing ids, which is unbounded storage growth.
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_ghost'), signal('ghost'))
    );
  });

  it('rejects a signal for a post that has since been deleted', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'posts/post2'));
    });
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_post2'), signal('post2'))
    );
  });
});

// -------------------------------------------------------------- cross-tenant

describe('INVARIANT: signals are private to their owner', () => {
  it('a user cannot write into another user subtree', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_post1'), signal('post1'))
    );
  });

  it('a user cannot read what another user has seen or hidden', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        interactionRef(ctx.firestore(), ALICE, 'not_interested_post1'),
        signal('post1', 'not_interested')
      );
    });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDoc(interactionRef(db, ALICE, 'not_interested_post1')));
  });

  it('a user cannot delete another user signals', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(interactionRef(ctx.firestore(), ALICE, 'impression_post1'), signal('post1'));
    });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(deleteDoc(interactionRef(db, ALICE, 'impression_post1')));
  });

  it('an unauthenticated client cannot write signals at all', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(interactionRef(db, ALICE, 'impression_post1'), signal('post1'))
    );
  });
});

// ------------------------------------------------------- the staleness marker

describe('INVARIANT: the taste generation only moves forward, in small steps', () => {
  it('a first bump creates the marker', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'userTasteState', ALICE),
        { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true })
    );
    expect(await readGeneration(ALICE)).toBe(1);
  });

  it('increments are accepted', async () => {
    await seedGeneration(ALICE, 5);
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'userTasteState', ALICE),
        { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true })
    );
    expect(await readGeneration(ALICE)).toBe(6);
  });

  it('rejects moving the marker backward', async () => {
    // Lowering it would make an already-stale cached taste vector look fresh,
    // which is how a user would pin their profile to an old state.
    await seedGeneration(ALICE, 5);
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'userTasteState', ALICE), { generation: 4, updatedAt: serverTimestamp() })
    );
    await assertFails(
      updateDoc(doc(db, 'userTasteState', ALICE), { generation: 0, updatedAt: serverTimestamp() })
    );
    await assertFails(
      updateDoc(doc(db, 'userTasteState', ALICE), { generation: increment(-1), updatedAt: serverTimestamp() })
    );
    expect(await readGeneration(ALICE)).toBe(5);
  });

  it('rejects standing still', async () => {
    await seedGeneration(ALICE, 5);
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'userTasteState', ALICE), { generation: 5, updatedAt: serverTimestamp() })
    );
  });

  it('rejects an absurd jump', async () => {
    await seedGeneration(ALICE, 5);
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    for (const generation of [100, 1e9, Number.MAX_SAFE_INTEGER]) {
      await assertFails(
        updateDoc(doc(db, 'userTasteState', ALICE), { generation, updatedAt: serverTimestamp() })
      );
    }
    expect(await readGeneration(ALICE)).toBe(5);
  });

  it('rejects a non-integer or non-numeric marker', async () => {
    await seedGeneration(ALICE, 5);
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'userTasteState', ALICE), { generation: 5.5, updatedAt: serverTimestamp() })
    );
    await assertFails(
      updateDoc(doc(db, 'userTasteState', ALICE), { generation: 'many', updatedAt: serverTimestamp() })
    );
  });

  it('rejects a first write that starts high', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'userTasteState', ALICE), { generation: 1e6, updatedAt: serverTimestamp() })
    );
  });

  it('rejects extra fields on the marker', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'userTasteState', ALICE),
        { generation: 1, updatedAt: serverTimestamp(), pinned: true })
    );
  });

  it('cannot be deleted to reset it', async () => {
    await seedGeneration(ALICE, 5);
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(deleteDoc(doc(db, 'userTasteState', ALICE)));
    expect(await readGeneration(ALICE)).toBe(5);
  });

  it('a user cannot touch another user marker', async () => {
    await seedGeneration(ALICE, 5);
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'userTasteState', ALICE),
        { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true })
    );
    await assertFails(getDoc(doc(db, 'userTasteState', ALICE)));
    expect(await readGeneration(ALICE)).toBe(5);
  });
});

// --------------------------------------------- atomicity of the invalidation

describe('INVARIANT: every taste-relevant mutation carries its own invalidation', () => {
  it('a like and its invalidation commit together', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    batch.set(doc(collection(doc(db, 'posts/post1'), 'likes'), BOB),
      { uid: BOB, createdAt: 'now' });
    batch.update(doc(db, 'posts/post1'), { likesCount: increment(1) });
    batch.set(doc(db, 'userTasteState', BOB),
      { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true });
    await assertSucceeds(batch.commit());
    expect(await readGeneration(BOB)).toBe(1);
  });

  it('a save and its invalidation commit together', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'saves', `${BOB}_post1`),
      { uid: BOB, postId: 'post1', createdAt: new Date().toISOString() });
    batch.set(doc(db, 'userTasteState', BOB),
      { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true });
    await assertSucceeds(batch.commit());
    expect(await readGeneration(BOB)).toBe(1);
  });

  it('an unsave and its invalidation commit together', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'saves', `${BOB}_post1`),
        { uid: BOB, postId: 'post1', createdAt: new Date().toISOString() });
    });
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    batch.delete(doc(db, 'saves', `${BOB}_post1`));
    batch.set(doc(db, 'userTasteState', BOB),
      { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true });
    await assertSucceeds(batch.commit());
    expect(await readGeneration(BOB)).toBe(1);
  });

  it('a comment and its invalidation commit together', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const commentRef = doc(collection(db, 'comments'));
    const batch = writeBatch(db);
    batch.set(commentRef, {
      postId: 'post1', authorId: BOB, authorEmail: BOB_EMAIL,
      content: 'nice fit', createdAt: new Date().toISOString(),
    });
    batch.set(doc(db, 'userTasteState', BOB),
      { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true });
    batch.update(doc(db, 'posts/post1'),
      { commentsCount: increment(1), lastCommentId: commentRef.id });
    await assertSucceeds(batch.commit());
    expect(await readGeneration(BOB)).toBe(1);
  });

  it('explicit feedback and its invalidation commit together', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    batch.set(interactionRef(db, BOB, 'not_interested_post1'), signal('post1', 'not_interested'));
    batch.delete(interactionRef(db, BOB, 'more_like_this_post1'));
    batch.set(doc(db, 'userTasteState', BOB),
      { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true });
    await assertSucceeds(batch.commit());
    expect(await readGeneration(BOB)).toBe(1);
  });

  it('a rejected mutation takes its invalidation down with it', async () => {
    // The whole point of batching: if the like is refused, the marker must
    // not have moved either, or the backend rebuilds for nothing.
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const batch = writeBatch(db);
    batch.set(doc(collection(doc(db, 'posts/post1'), 'likes'), ALICE),
      { uid: ALICE, createdAt: 'now' });          // not BOB's like to make
    batch.update(doc(db, 'posts/post1'), { likesCount: increment(1) });
    batch.set(doc(db, 'userTasteState', BOB),
      { generation: increment(1), updatedAt: serverTimestamp() }, { merge: true });
    await assertFails(batch.commit());
    expect(await readGeneration(BOB)).toBeUndefined();
  });
});
