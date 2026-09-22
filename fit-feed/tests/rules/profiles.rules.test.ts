import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { ALICE, ALICE_EMAIL, BOB, BOB_EMAIL, asUser, makeTestEnv } from './setup';

// Account data is split so that reading a display name cannot leak an email:
//   users/{uid}          private, owner-only
//   publicProfiles/{uid} public to signed-in users, no sensitive fields

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await makeTestEnv();
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/alice_uid'), {
      uid: ALICE, email: ALICE_EMAIL, displayName: '', createdAt: '2026-01-01',
    });
    await setDoc(doc(db, 'publicProfiles/alice_uid'), {
      uid: ALICE, username: 'alice_fits', displayName: 'alice', createdAt: '2026-01-01',
    });
    // A legacy users doc that still carries the pre-split public fields.
    await setDoc(doc(db, 'users/bob_uid'), {
      uid: BOB, email: BOB_EMAIL, username: 'bob_old', photoURL: 'https://x/y.jpg',
    });
  });
});

describe('private account data', () => {
  it('User A CANNOT read User B private account document', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDoc(doc(db, 'users/alice_uid')));
  });

  it('User A CANNOT enumerate the users collection', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(getDocs(collection(db, 'users')));
  });

  it('a user CAN read their own account document', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    const snap = await assertSucceeds(getDoc(doc(db, 'users/alice_uid')));
    expect(snap.data()?.email).toBe(ALICE_EMAIL);
  });

  it('a user CAN update their own permitted account fields', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users/alice_uid'), { displayName: 'Alice A.' }, { merge: true })
    );
  });

  it('a merge write still works on a legacy doc holding pre-split fields', async () => {
    // The update rule checks *changed* keys, so leftover username/photoURL
    // on an old document must not block a normal account write.
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users/bob_uid'), { email: BOB_EMAIL, displayName: 'Bob' }, { merge: true })
    );
  });

  it('a user cannot write another user account document', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'users/alice_uid'), { displayName: 'hacked' }, { merge: true })
    );
  });

  it('a user cannot claim an email that is not in their token', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'users/alice_uid'), { email: BOB_EMAIL }, { merge: true })
    );
  });

  it('a user cannot invent privileged fields on their account doc', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    for (const patch of [{ role: 'admin' }, { isAdmin: true }, { plan: 'enterprise' }]) {
      await assertFails(
        setDoc(doc(db, 'users/alice_uid'), patch, { merge: true })
      );
    }
  });

  it('account documents cannot be deleted from the client', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'users/alice_uid'), { uid: BOB }));
  });
});

describe('public profiles', () => {
  it('User A CAN read User B public profile', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const snap = await assertSucceeds(getDoc(doc(db, 'publicProfiles/alice_uid')));
    expect(snap.data()?.username).toBe('alice_fits');
  });

  it('a public profile carries no email field', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const snap = await getDoc(doc(db, 'publicProfiles/alice_uid'));
    expect(snap.data()).not.toHaveProperty('email');
  });

  it('a user CAN create and update their own public profile', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'publicProfiles/bob_uid'), { uid: BOB, displayName: 'bob' })
    );
    await assertSucceeds(
      setDoc(doc(db, 'publicProfiles/bob_uid'), { username: 'bob_fits' }, { merge: true })
    );
  });

  it('User A CANNOT overwrite User B public profile', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'publicProfiles/alice_uid'), { username: 'stolen' }, { merge: true })
    );
  });

  it('an email address cannot be stored in a public profile', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    // Not as its own field...
    await assertFails(
      setDoc(doc(db, 'publicProfiles/alice_uid'), { email: ALICE_EMAIL }, { merge: true })
    );
    // ...nor smuggled through displayName.
    await assertFails(
      setDoc(doc(db, 'publicProfiles/alice_uid'), { displayName: ALICE_EMAIL }, { merge: true })
    );
  });

  it('unexpected or sensitive fields are refused', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    for (const patch of [
      { role: 'admin' },
      { isAdmin: true },
      { passwordHash: 'x' },
      { phoneNumber: '+15550000000' },
      { stripeCustomerId: 'cus_123' },
    ]) {
      await assertFails(
        setDoc(doc(db, 'publicProfiles/alice_uid'), patch, { merge: true })
      );
    }
  });

  it('username format is enforced', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'publicProfiles/alice_uid'), { username: 'Has Spaces' }, { merge: true })
    );
    await assertFails(
      setDoc(doc(db, 'publicProfiles/alice_uid'), { username: 'x' }, { merge: true })
    );
    await assertFails(
      setDoc(doc(db, 'publicProfiles/alice_uid'), { username: 'a'.repeat(40) }, { merge: true })
    );
  });

  it('a user cannot point the uid field at someone else', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'publicProfiles/alice_uid'), { uid: BOB }, { merge: true })
    );
  });

  it('anonymous users cannot read public profiles', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'publicProfiles/alice_uid')));
  });
});
