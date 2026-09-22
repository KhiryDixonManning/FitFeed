#!/usr/bin/env node
/**
 * Rehearse the production migration against the local emulators.
 *
 * Walks the operational sequence end to end and asserts the behaviour an
 * operator will be checking for at each step:
 *
 *   1. STRICT (today)        legacy client works, new client is refused
 *   2. TRANSITIONAL          both clients work
 *   3. MIGRATION             legacy likes are backfilled into the subcollection
 *   4. NEW CLIENT            the new path works; counts stay honest
 *   5. STRICT (after)        legacy writes are refused; the new path is fine
 *
 * The point is to find out that a step behaves unexpectedly here, on throwaway
 * data, rather than in the middle of a production window.
 *
 * SAFETY: this only ever talks to the Firestore emulator. It refuses to run
 * unless FIRESTORE_EMULATOR_HOST is set, and it hard-fails if that value
 * points anywhere other than localhost. There is no flag to aim it at a real
 * project, by design.
 *
 *   npm run rehearse:migration
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  arrayUnion, collection, doc, getDoc, getDocs, increment,
  runTransaction, setDoc, updateDoc,
} from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// ------------------------------------------------------------------ safety

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulator) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  console.error('This rehearsal only ever runs against the emulator. Use:');
  console.error('  npm run rehearse:migration');
  process.exit(2);
}
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(emulator)) {
  console.error(`Refusing to run: FIRESTORE_EMULATOR_HOST is "${emulator}".`);
  console.error('That is not a local emulator. This script never targets a real project.');
  process.exit(2);
}

const [host, port] = emulator.split(':');

// ------------------------------------------------------------- scaffolding

const ALICE = 'alice_uid';      // post author
const BOB = 'bob_uid';          // on the old client
const CAROL = 'carol_uid';      // on the new client

let step = 0;
const failures = [];

function heading(title) {
  step += 1;
  console.log('');
  console.log(`--- step ${step}: ${title}`);
}

async function check(label, fn) {
  try {
    await fn();
    console.log(`    ok    ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`    FAIL  ${label}`);
    console.error(`          ${error.message?.split('\n')[0] ?? error}`);
  }
}

function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

async function envFor(projectId, rulesFile) {
  return initializeTestEnvironment({
    projectId,
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync(resolve(root, rulesFile), 'utf8'),
    },
  });
}

const user = (env, uid) => env.authenticatedContext(uid, { email: `${uid}@example.com` }).firestore();

async function seedPost(env, { likesCount = 0, likedBy = [] } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'posts/post1'), {
      authorId: ALICE,
      content: 'a caption',
      imageUrl:
        'https://firebasestorage.googleapis.com/v0/b/fitfeed-67ee8.firebasestorage.app/o/posts%2F' +
        `${ALICE}%2F1.jpg?alt=media`,
      category: 'streetwear',
      outfitBreakdown: '',
      likesCount,
      commentsCount: 0,
      likedBy,
      createdAt: new Date(),
      analysisStatus: 'pending',
    });
  });
}

async function state(env) {
  let out;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const postRef = doc(ctx.firestore(), 'posts/post1');
    const data = (await getDoc(postRef)).data() ?? {};
    const likes = await getDocs(collection(postRef, 'likes'));
    out = {
      likesCount: data.likesCount ?? -1,
      likedBy: [...(data.likedBy ?? [])].sort(),
      likeDocs: likes.docs.map((d) => d.id).sort(),
    };
  });
  return out;
}

/** What the deployed (old) client does. */
const legacyLike = (db, uid) =>
  updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1), likedBy: arrayUnion(uid) });

/** What the new client does. */
function modernToggle(db, uid) {
  const postRef = doc(db, 'posts/post1');
  const likeRef = doc(collection(postRef, 'likes'), uid);
  return runTransaction(db, async (tx) => {
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

/** What migrate_likes.py --apply does, in miniature. */
async function backfill(env) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const postRef = doc(ctx.firestore(), 'posts/post1');
    const data = (await getDoc(postRef)).data() ?? {};
    for (const uid of data.likedBy ?? []) {
      await setDoc(doc(collection(postRef, 'likes'), uid), {
        uid, createdAt: new Date().toISOString(),
      });
    }
  });
}

// --------------------------------------------------------------- the walk

console.log('FitFeed migration rehearsal');
console.log(`emulator: ${emulator}`);

const strictBefore = await envFor('rehearse-strict-before', 'firestore.rules');
const transitional = await envFor('rehearse-transitional', 'firestore.transition.rules');
const strictAfter = await envFor('rehearse-strict-after', 'firestore.rules');

try {
  // -- 1 ---------------------------------------------------------------
  heading('STRICT rules, today: only the new path is allowed');
  await seedPost(strictBefore);

  await check('the deployed legacy client is REFUSED (this is why we need the window)',
    () => assertFails(legacyLike(user(strictBefore, BOB), BOB)));

  await check('the new client works',
    async () => {
      await assertSucceeds(modernToggle(user(strictBefore, CAROL), CAROL));
      assertEqual((await state(strictBefore)).likesCount, 1, 'likesCount');
    });

  // -- 2 ---------------------------------------------------------------
  heading('TRANSITIONAL rules: both clients work');
  await seedPost(transitional);

  await check('the legacy client can like again',
    async () => {
      await assertSucceeds(legacyLike(user(transitional, BOB), BOB));
      assertEqual((await state(transitional)).likedBy, [BOB], 'likedBy');
    });

  await check('the new client still works alongside it',
    async () => {
      await assertSucceeds(modernToggle(user(transitional, CAROL), CAROL));
      const s = await state(transitional);
      assertEqual(s.likesCount, 2, 'likesCount');
      assertEqual(s.likeDocs, [CAROL], 'like documents');
    });

  await check('a legacy write cannot smuggle another field',
    () => assertFails(updateDoc(doc(user(transitional, BOB), 'posts/post1'), {
      likesCount: increment(1), likedBy: arrayUnion(BOB), content: 'hijacked',
    })));

  await check('a legacy write cannot touch another user',
    () => assertFails(updateDoc(doc(user(transitional, BOB), 'posts/post1'), {
      likesCount: increment(1), likedBy: arrayUnion('victim_uid'),
    })));

  // -- 3 ---------------------------------------------------------------
  heading('MIGRATION: backfill legacy likes into the subcollection');
  await seedPost(transitional, { likesCount: 2, likedBy: [BOB, 'dave_uid'] });
  await backfill(transitional);

  await check('every legacy liker now has a like document',
    async () => {
      const s = await state(transitional);
      assertEqual(s.likeDocs, [BOB, 'dave_uid'].sort(), 'like documents');
      assertEqual(s.likesCount, 2, 'likesCount');
    });

  await check('the legacy array is preserved, not deleted (it is the rollback path)',
    async () => assertEqual((await state(transitional)).likedBy, [BOB, 'dave_uid'].sort(),
      'likedBy'));

  await check('a backfilled user cannot double-like through the legacy path',
    () => assertFails(legacyLike(user(transitional, BOB), BOB)));

  // -- 4 ---------------------------------------------------------------
  heading('NEW CLIENT: the migrated path behaves');
  await check('a backfilled user can unlike through the new path',
    async () => {
      await assertSucceeds(modernToggle(user(transitional, BOB), BOB));
      const s = await state(transitional);
      assertEqual(s.likesCount, 1, 'likesCount');
      assertEqual(s.likeDocs, ['dave_uid'], 'like documents');
    });

  await check('counts stay honest under concurrent new-path likes',
    async () => {
      await seedPost(transitional);
      const uids = [BOB, CAROL, 'dave_uid', 'erin_uid'];
      await Promise.all(uids.map((uid) => modernToggle(user(transitional, uid), uid)));
      const s = await state(transitional);
      assertEqual(s.likesCount, 4, 'likesCount');
      assertEqual(s.likeDocs.length, 4, 'like document count');
    });

  await check('a double-click cannot register two likes',
    async () => {
      await seedPost(transitional);
      const db = user(transitional, BOB);
      await Promise.allSettled([modernToggle(db, BOB), modernToggle(db, BOB)]);
      const s = await state(transitional);
      if (s.likesCount !== s.likeDocs.length) {
        throw new Error(`counter ${s.likesCount} != ${s.likeDocs.length} like documents`);
      }
    });

  // -- 5 ---------------------------------------------------------------
  heading('STRICT rules again: the window closes');
  await seedPost(strictAfter, { likesCount: 1, likedBy: [BOB] });
  await strictAfter.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(collection(doc(ctx.firestore(), 'posts/post1'), 'likes'), BOB),
      { uid: BOB, createdAt: 'migrated' }
    );
  });

  await check('legacy writes are refused again',
    () => assertFails(legacyLike(user(strictAfter, CAROL), CAROL)));

  await check('the new path still works, so closing the window breaks nothing',
    async () => {
      await assertSucceeds(modernToggle(user(strictAfter, CAROL), CAROL));
      assertEqual((await state(strictAfter)).likesCount, 2, 'likesCount');
    });

  await check('historical likedBy data survives the whole sequence',
    async () => assertEqual((await state(strictAfter)).likedBy, [BOB], 'likedBy'));
} finally {
  await Promise.all([
    strictBefore.cleanup(), transitional.cleanup(), strictAfter.cleanup(),
  ]);
}

console.log('');
if (failures.length > 0) {
  console.error(`REHEARSAL FAILED: ${failures.length} check(s) did not behave as expected:`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  console.error('Do NOT run the production migration until these are understood.');
  process.exit(1);
}
console.log('Rehearsal passed. Every step of the migration sequence behaved as documented.');
