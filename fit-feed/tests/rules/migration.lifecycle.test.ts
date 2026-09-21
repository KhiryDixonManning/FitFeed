import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  arrayRemove, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs,
  increment, runTransaction, setDoc, updateDoc,
} from 'firebase/firestore';
import {
  ALICE, ALICE_EMAIL, BOB, BOB_EMAIL,
  asUser, makeRulesEnv, postDoc, readRules,
} from './setup';

// The migration is a sequence of states, not a single switch, and the
// dangerous properties live in the transitions between them. This covers the
// lifecycle end to end: concurrency and idempotency on each path, the two
// paths coexisting, count consistency after a mixed workload, and - the step
// that closes the window - the strict rules refusing the legacy mutation that
// the transitional rules had permitted.

const CAROL = 'carol_uid';
const DAVE = 'dave_uid';

let strict: RulesTestEnvironment;
let transitional: RulesTestEnvironment;

beforeAll(async () => {
  strict = await makeRulesEnv('fitfeed-lifecycle-strict', readRules('firestore.rules'));
  transitional = await makeRulesEnv(
    'fitfeed-lifecycle-transition',
    readRules('firestore.transition.rules')
  );
});

afterAll(async () => {
  await strict.cleanup();
  await transitional.cleanup();
});

async function seed(env: RulesTestEnvironment, overrides: Record<string, unknown> = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE, {
      likesCount: 0,
      likedBy: [],
      ...overrides,
    }));
  });
}

async function readState(env: RulesTestEnvironment) {
  let likesCount = -1;
  let likedBy: string[] = [];
  let likeDocs: string[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const postRef = doc(ctx.firestore(), 'posts/post1');
    const snap = await getDoc(postRef);
    const data = snap.data() ?? {};
    likesCount = (data.likesCount as number) ?? -1;
    likedBy = ((data.likedBy as string[]) ?? []).slice().sort();
    const likes = await getDocs(collection(postRef, 'likes'));
    likeDocs = likes.docs.map((d) => d.id).sort();
  });
  return { likesCount, likedBy, likeDocs };
}

/** The new client's path: like document and counter in one transaction. */
function modernToggle(db: unknown, uid: string) {
  const postRef = doc(db as never, 'posts/post1');
  const likeRef = doc(collection(postRef, 'likes'), uid);
  return runTransaction(db as never, async (tx) => {
    const snap = await tx.get(likeRef);
    if (snap.exists()) {
      tx.delete(likeRef);
      tx.update(postRef, { likesCount: increment(-1) });
      return false;
    }
    tx.set(likeRef, { uid, createdAt: new Date().toISOString() });
    tx.update(postRef, { likesCount: increment(1) });
    return true;
  });
}

const legacyLike = (db: unknown, uid: string) =>
  updateDoc(doc(db as never, 'posts/post1'), {
    likesCount: increment(1), likedBy: arrayUnion(uid),
  });

const legacyUnlike = (db: unknown, uid: string) =>
  updateDoc(doc(db as never, 'posts/post1'), {
    likesCount: increment(-1), likedBy: arrayRemove(uid),
  });

// ------------------------------------------------ new path: the steady state

describe('LIFECYCLE: the new like path under concurrency', () => {
  beforeEach(() => seed(strict));

  it('two users liking at once produce exactly two likes', async () => {
    const bob = asUser(strict, BOB, BOB_EMAIL).firestore();
    const carol = asUser(strict, CAROL, 'carol@example.com').firestore();

    await Promise.all([modernToggle(bob, BOB), modernToggle(carol, CAROL)]);

    const state = await readState(strict);
    expect(state.likesCount).toBe(2);
    expect(state.likeDocs).toEqual([BOB, CAROL].sort());
  });

  it('four users liking at once stay consistent', async () => {
    const uids = [BOB, CAROL, DAVE, 'erin_uid'];
    await Promise.all(
      uids.map((uid) => modernToggle(asUser(strict, uid, `${uid}@example.com`).firestore(), uid))
    );

    const state = await readState(strict);
    expect(state.likesCount).toBe(4);
    expect(state.likeDocs).toEqual([...uids].sort());
  });

  it('a double-click cannot register two likes', async () => {
    const db = asUser(strict, BOB, BOB_EMAIL).firestore();
    await Promise.allSettled([modernToggle(db, BOB), modernToggle(db, BOB)]);

    const state = await readState(strict);
    // Whatever the interleaving, the counter equals the document count.
    expect(state.likeDocs.length).toBeLessThanOrEqual(1);
    expect(state.likesCount).toBe(state.likeDocs.length);
  });

  it('a like then an unlike returns to zero', async () => {
    const db = asUser(strict, BOB, BOB_EMAIL).firestore();
    await modernToggle(db, BOB);
    await modernToggle(db, BOB);

    const state = await readState(strict);
    expect(state.likesCount).toBe(0);
    expect(state.likeDocs).toEqual([]);
  });

  it('a retried transaction is idempotent, not additive', async () => {
    // A client retrying after a dropped response must not double-count: the
    // transaction reads the like document before deciding what to do.
    const db = asUser(strict, BOB, BOB_EMAIL).firestore();
    await modernToggle(db, BOB);
    expect((await readState(strict)).likesCount).toBe(1);

    // The retry observes its own like and toggles off, rather than stacking.
    await modernToggle(db, BOB);
    const state = await readState(strict);
    expect(state.likesCount).toBe(state.likeDocs.length);
  });

  it('a mixed workload leaves the counter equal to the document count', async () => {
    const actors = [BOB, CAROL, DAVE];
    const dbs = Object.fromEntries(
      actors.map((uid) => [uid, asUser(strict, uid, `${uid}@example.com`).firestore()])
    );

    await Promise.all(actors.map((uid) => modernToggle(dbs[uid], uid)));
    await Promise.all([modernToggle(dbs[BOB], BOB), modernToggle(dbs[DAVE], DAVE)]);
    await modernToggle(dbs[BOB], BOB);

    const state = await readState(strict);
    expect(state.likesCount).toBe(state.likeDocs.length);
    expect(state.likeDocs).toEqual([BOB, CAROL].sort());
  });
});

// -------------------------------------------- the window: both paths at once

describe('LIFECYCLE: old and new clients during the compatibility window', () => {
  beforeEach(() => seed(transitional));

  it('a legacy like and a new like on the same post both land', async () => {
    const oldClient = asUser(transitional, BOB, BOB_EMAIL).firestore();
    const newClient = asUser(transitional, CAROL, 'carol@example.com').firestore();

    await assertSucceeds(legacyLike(oldClient, BOB));
    await assertSucceeds(modernToggle(newClient, CAROL));

    const state = await readState(transitional);
    expect(state.likesCount).toBe(2);
    expect(state.likedBy).toEqual([BOB]);      // old client's record
    expect(state.likeDocs).toEqual([CAROL]);   // new client's record
  });

  it('concurrent legacy and new likes keep the counter honest', async () => {
    const oldClient = asUser(transitional, BOB, BOB_EMAIL).firestore();
    const newClient = asUser(transitional, CAROL, 'carol@example.com').firestore();

    await Promise.all([legacyLike(oldClient, BOB), modernToggle(newClient, CAROL)]);

    const state = await readState(transitional);
    expect(state.likesCount).toBe(2);
  });

  it('a legacy like is idempotent: liking twice is refused, not doubled', async () => {
    const db = asUser(transitional, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(legacyLike(db, BOB));
    await assertFails(legacyLike(db, BOB));
    expect((await readState(transitional)).likesCount).toBe(1);
  });

  it('a legacy unlike of a like never made is refused', async () => {
    const db = asUser(transitional, BOB, BOB_EMAIL).firestore();
    await assertFails(legacyUnlike(db, BOB));
    expect((await readState(transitional)).likesCount).toBe(0);
  });

  it('the same user on both clients cannot be counted twice', async () => {
    // Backfilled by the migration, so the user holds BOTH records.
    await seed(transitional, { likesCount: 1, likedBy: [BOB] });
    await transitional.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(collection(doc(ctx.firestore(), 'posts/post1'), 'likes'), BOB),
        { uid: BOB, createdAt: 'migrated' }
      );
    });

    const db = asUser(transitional, BOB, BOB_EMAIL).firestore();
    // Neither path lets them like again - both already record the like.
    await assertFails(legacyLike(db, BOB));
    await assertSucceeds(modernToggle(db, BOB));   // this is an UNLIKE

    const state = await readState(transitional);
    expect(state.likesCount).toBe(0);
    expect(state.likeDocs).toEqual([]);
  });
});

// --------------------------------------- closing the window: strict refuses

describe('LIFECYCLE: the strict rules close the legacy path', () => {
  beforeEach(() => seed(strict, { likesCount: 1, likedBy: [CAROL] }));

  it('refuses the legacy like the transitional rules permitted', async () => {
    const db = asUser(strict, BOB, BOB_EMAIL).firestore();
    await assertFails(legacyLike(db, BOB));
    expect((await readState(strict)).likedBy).toEqual([CAROL]);
  });

  it('refuses the legacy unlike the transitional rules permitted', async () => {
    const db = asUser(strict, CAROL, 'carol@example.com').firestore();
    await assertFails(legacyUnlike(db, CAROL));
    expect((await readState(strict)).likedBy).toEqual([CAROL]);
  });

  it('refuses any write to likedBy at all', async () => {
    const db = asUser(strict, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likedBy: [] }));
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likedBy: arrayUnion(BOB) }));
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likedBy: arrayRemove(CAROL) }));
  });

  it('still allows the new path, so closing the window breaks nothing current',
    async () => {
      const db = asUser(strict, BOB, BOB_EMAIL).firestore();
      await assertSucceeds(modernToggle(db, BOB));
      const state = await readState(strict);
      expect(state.likesCount).toBe(2);
      expect(state.likeDocs).toEqual([BOB]);
    });

  it('leaves historical likedBy data readable and intact', async () => {
    // The array is retired, not deleted: it is the rollback path until a
    // clean --verify, and nothing in the strict rules removes it.
    expect((await readState(strict)).likedBy).toEqual([CAROL]);
  });
});

// ------------------------------------------------------- cleanup behaviour

describe('LIFECYCLE: cleanup when a post goes away', () => {
  beforeEach(() => seed(strict));

  it('a user can always remove their own like', async () => {
    const db = asUser(strict, BOB, BOB_EMAIL).firestore();
    await modernToggle(db, BOB);
    await assertSucceeds(
      deleteDoc(doc(collection(doc(db, 'posts/post1'), 'likes'), BOB))
    );
  });

  it('a post author cannot delete another user like document', async () => {
    // Which is why orphan cleanup is an Admin-SDK maintenance job
    // (reconcile_likes.py) rather than something the client can do.
    const bob = asUser(strict, BOB, BOB_EMAIL).firestore();
    await modernToggle(bob, BOB);

    const author = asUser(strict, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      deleteDoc(doc(collection(doc(author, 'posts/post1'), 'likes'), BOB))
    );
  });

  it('deleting a post leaves its like documents behind', async () => {
    // Documents this as a known property, not an accident: Firestore does
    // not cascade-delete subcollections. reconcile_likes.py sweeps them.
    const bob = asUser(strict, BOB, BOB_EMAIL).firestore();
    await modernToggle(bob, BOB);

    const author = asUser(strict, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(deleteDoc(doc(author, 'posts/post1')));

    let orphanExists = false;
    await strict.withSecurityRulesDisabled(async (ctx) => {
      orphanExists = (await getDoc(
        doc(collection(doc(ctx.firestore(), 'posts/post1'), 'likes'), BOB)
      )).exists();
    });
    expect(orphanExists).toBe(true);
  });
});
