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
  ALICE, ALICE_EMAIL, BOB, BOB_EMAIL,
  asUser, makeRulesEnv, postDoc, readRules,
} from './setup';

// firestore.transition.rules is deployed for one window only: between the
// backend deploy and the frontend deploy, when the old client (which writes
// likedBy) and the new one (which writes a like document) are both live.
//
// The whole risk of a transitional policy is that it quietly permits more
// than intended. So this suite proves two things in equal measure: the one
// legacy shape works, and nothing adjacent to it does.

const CAROL = 'carol_uid';
const TRANSITION_PROJECT = 'fitfeed-transition-test';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await makeRulesEnv(TRANSITION_PROJECT, readRules('firestore.transition.rules'));
});
afterAll(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    // A post that already carries legacy likers, as production does today.
    await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE, {
      likesCount: 1,
      likedBy: [CAROL],
    }));
  });
});

async function readPost() {
  let data: Record<string, unknown> = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    data = ((await getDoc(doc(ctx.firestore(), 'posts/post1'))).data() ?? {}) as Record<string, unknown>;
  });
  return data;
}

async function readLikeIds(): Promise<string[]> {
  const { getDocs } = await import('firebase/firestore');
  let ids: string[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDocs(collection(doc(ctx.firestore(), 'posts/post1'), 'likes'));
    ids = snap.docs.map((d) => d.id).sort();
  });
  return ids;
}

/** Exactly what the deployed client sends. */
function legacyLike(db: unknown, uid: string) {
  return updateDoc(doc(db as never, 'posts/post1'), {
    likesCount: increment(1),
    likedBy: arrayUnion(uid),
  });
}

function legacyUnlike(db: unknown, uid: string) {
  return updateDoc(doc(db as never, 'posts/post1'), {
    likesCount: increment(-1),
    likedBy: arrayRemove(uid),
  });
}

/** What the new client sends: like document and counter in one transaction. */
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

// ------------------------------------------------- both clients keep working

describe('TRANSITIONAL: the old client still works', () => {
  it('a legacy like succeeds', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(legacyLike(db, BOB));

    const post = await readPost();
    expect(post.likesCount).toBe(2);
    expect(post.likedBy).toEqual([CAROL, BOB]);
  });

  it('a legacy unlike succeeds', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(legacyLike(db, BOB));
    await assertSucceeds(legacyUnlike(db, BOB));

    const post = await readPost();
    expect(post.likesCount).toBe(1);
    expect(post.likedBy).toEqual([CAROL]);
  });

  it('an existing liker can unlike a post they liked before the window', async () => {
    const db = asUser(env, CAROL, 'carol@example.com').firestore();
    await assertSucceeds(legacyUnlike(db, CAROL));

    const post = await readPost();
    expect(post.likesCount).toBe(0);
    expect(post.likedBy).toEqual([]);
  });
});

describe('TRANSITIONAL: the new client also works', () => {
  it('a subcollection like succeeds', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(modernToggle(db, BOB));

    expect((await readPost()).likesCount).toBe(2);
    let exists = false;
    await env.withSecurityRulesDisabled(async (ctx) => {
      exists = (await getDoc(
        doc(collection(doc(ctx.firestore(), 'posts/post1'), 'likes'), BOB)
      )).exists();
    });
    expect(exists).toBe(true);
  });

  it('a subcollection unlike succeeds', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(modernToggle(db, BOB));
    await assertSucceeds(modernToggle(db, BOB));
    expect((await readPost()).likesCount).toBe(1);
  });

  it('the two paths do not interfere', async () => {
    // Bob on the new client, Carol unliking on the old one.
    const bob = asUser(env, BOB, BOB_EMAIL).firestore();
    const carol = asUser(env, CAROL, 'carol@example.com').firestore();
    await assertSucceeds(modernToggle(bob, BOB));
    await assertSucceeds(legacyUnlike(carol, CAROL));

    const post = await readPost();
    expect(post.likesCount).toBe(1);
    expect(post.likedBy).toEqual([]);
  });
});

describe('TRANSITIONAL: an old-client unlike leaves the like document behind', () => {
  // The premise of the Phase G prune, proven at the rules layer rather than
  // assumed by the Python lifecycle test that simulates it.
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      // Post-migration state: the user holds BOTH representations.
      await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE, {
        likesCount: 1, likedBy: [BOB],
      }));
      await setDoc(
        doc(collection(doc(ctx.firestore(), 'posts/post1'), 'likes'), BOB),
        { uid: BOB, createdAt: 'migrated' }
      );
    });
  });

  it('the legacy unlike is permitted and removes only the array entry', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(legacyUnlike(db, BOB));

    const post = await readPost();
    expect(post.likedBy).toEqual([]);
    expect(post.likesCount).toBe(0);
    // The old client cannot reach the subcollection, so the document remains.
    expect(await readLikeIds()).toEqual([BOB]);
  });

  it('the old client cannot delete the like document itself', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    // Even its owner cannot remove it as part of the legacy mutation: the
    // changed-key pin forbids anything but likesCount and likedBy, and a
    // subcollection delete is a separate write the old client never makes.
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(-1),
        likedBy: arrayRemove(BOB),
        likes: null,
      })
    );
    expect(await readLikeIds()).toEqual([BOB]);
  });

  it('leaves the post readable as still-liked until a prune runs', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(legacyUnlike(db, BOB));
    // Which is why Phase G must prune: the subcollection is what the new
    // client reads, and it still says liked.
    expect(await readLikeIds()).toContain(BOB);
  });
});

// ------------------------------------- the allowance is exactly one shape wide

describe('TRANSITIONAL: the legacy allowance is not a general post write', () => {
  it('rejects replacing likedBy wholesale', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: 2, likedBy: [BOB] })
    );
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(1),
        likedBy: [BOB, CAROL, 'someone', 'else'],
      })
    );
    expect((await readPost()).likedBy).toEqual([CAROL]);
  });

  it('rejects adding another user to likedBy', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(1),
        likedBy: arrayUnion('victim_uid'),
      })
    );
    expect((await readPost()).likedBy).toEqual([CAROL]);
  });

  it('rejects removing another user from likedBy', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(-1),
        likedBy: arrayRemove(CAROL),
      })
    );
    expect((await readPost()).likedBy).toEqual([CAROL]);
  });

  it('rejects adding self and removing someone else in one write', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1), likedBy: [BOB] })
    );
    expect((await readPost()).likedBy).toEqual([CAROL]);
  });

  it('rejects moving the counter by more than one', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(50),
        likedBy: arrayUnion(BOB),
      })
    );
    expect((await readPost()).likesCount).toBe(1);
  });

  it('rejects the counter moving without the array', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1) }));
  });

  it('rejects the array moving without the counter', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { likedBy: arrayUnion(BOB) }));
  });

  it('rejects liking twice, because arrayUnion is idempotent', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertSucceeds(legacyLike(db, BOB));
    // The array cannot grow again, so the counter step has nothing to pair with.
    await assertFails(legacyLike(db, BOB));
    expect((await readPost()).likesCount).toBe(2);
  });
});

describe('TRANSITIONAL: unrelated fields cannot ride along', () => {
  it('rejects a caption edit smuggled into a legacy like', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(1),
        likedBy: arrayUnion(BOB),
        content: 'hijacked caption',
      })
    );
    expect((await readPost()).content).toBe('a caption');
  });

  it('rejects a commentsCount change smuggled into a legacy like', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(1),
        likedBy: arrayUnion(BOB),
        commentsCount: increment(1),
      })
    );
  });

  it('rejects an authorId change, alone or alongside a legacy like', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(updateDoc(doc(db, 'posts/post1'), { authorId: BOB }));
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(1),
        likedBy: arrayUnion(BOB),
        authorId: BOB,
      })
    );
    expect((await readPost()).authorId).toBe(ALICE);
  });

  it('rejects an imageUrl change alongside a legacy like', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        likesCount: increment(1),
        likedBy: arrayUnion(BOB),
        imageUrl: 'https://evil.example.com/x.jpg',
      })
    );
  });
});

describe('TRANSITIONAL: server-owned analysis fields stay server-owned', () => {
  const aiFields: Record<string, unknown>[] = [
    { analyzed: true },
    { analysisStatus: 'complete' },
    { aesthetic: 'streetwear' },
    { aestheticScores: { streetwear: 1 } },
    { aestheticTags: ['forged'] },
    { detectedItems: ['forged'] },
    { palette: [{ hex: '#000000', percentage: 100 }] },
    { outfitName: 'forged' },
    { styleDescription: 'forged' },
    { styleNotes: 'forged' },
  ];

  for (const field of aiFields) {
    const name = Object.keys(field)[0];
    it(`rejects writing ${name} directly`, async () => {
      const db = asUser(env, ALICE, ALICE_EMAIL).firestore();   // even the author
      await assertFails(updateDoc(doc(db, 'posts/post1'), field));
    });

    it(`rejects writing ${name} alongside a legacy like`, async () => {
      const db = asUser(env, BOB, BOB_EMAIL).firestore();
      await assertFails(
        updateDoc(doc(db, 'posts/post1'), {
          likesCount: increment(1),
          likedBy: arrayUnion(BOB),
          ...field,
        })
      );
    });
  }
});

describe('TRANSITIONAL: cross-user protections are unchanged', () => {
  it('a user cannot write another user interaction signal', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(
        doc(collection(doc(db, 'users', ALICE), 'interactions'), 'impression_post1'),
        { postId: 'post1', type: 'impression', createdAt: 'now', schemaVersion: 1 }
      )
    );
  });

  it('a user cannot touch another user taste marker', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'userTasteState', ALICE), { generation: 1, updatedAt: 'now' })
    );
  });

  it('a user cannot write another user public profile', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'publicProfiles', ALICE), { uid: ALICE, username: 'stolen' })
    );
  });

  it('analysis jobs remain unwritable by any client', async () => {
    const db = asUser(env, ALICE, ALICE_EMAIL).firestore();
    await assertFails(
      setDoc(doc(db, 'analysisJobs', 'post1'), { status: 'complete', attempts: 0 })
    );
  });

  it('a user cannot delete another user post', async () => {
    const { deleteDoc } = await import('firebase/firestore');
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(deleteDoc(doc(db, 'posts/post1')));
  });

  it('an unauthenticated client cannot use the legacy path', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), { likesCount: increment(1), likedBy: ['anyone'] })
    );
  });

  it('a comment counter still needs a real comment', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    await assertFails(
      updateDoc(doc(db, 'posts/post1'), {
        commentsCount: increment(1),
        lastCommentId: 'invented',
      })
    );
  });

  it('a comment batch still works under the transitional rules', async () => {
    const db = asUser(env, BOB, BOB_EMAIL).firestore();
    const commentRef = doc(collection(db, 'comments'));
    const batch = writeBatch(db);
    batch.set(commentRef, {
      postId: 'post1', authorId: BOB, authorEmail: BOB_EMAIL,
      content: 'nice fit', createdAt: new Date().toISOString(),
    });
    batch.update(doc(db, 'posts/post1'), {
      commentsCount: increment(1),
      lastCommentId: commentRef.id,
    });
    await assertSucceeds(batch.commit());
  });
});

// ------------------------------------------------------------ mutation tests

describe('MUTATION: the transitional tests detect a weakened rule', () => {
  // A rule test that still passes against a deliberately broken rule is not
  // testing anything. Each case below weakens one clause of the transitional
  // allowance and asserts the attack it was guarding now SUCCEEDS -- proving
  // that clause, and not something else, is what refuses the write.

  async function withWeakenedRules(
    projectId: string,
    mutate: (rules: string) => string,
    body: (env: RulesTestEnvironment) => Promise<void>
  ) {
    const original = readRules('firestore.transition.rules');
    const weakened = mutate(original);
    expect(weakened, 'the mutation did not change the rules').not.toBe(original);

    const weakEnv = await makeRulesEnv(projectId, weakened);
    try {
      await weakEnv.clearFirestore();
      await weakEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'posts/post1'), postDoc(ALICE, {
          likesCount: 1,
          likedBy: [CAROL],
        }));
      });
      await body(weakEnv);
    } finally {
      await weakEnv.cleanup();
    }
  }

  it('dropping the own-uid check would let a user forge another user like', async () => {
    await withWeakenedRules(
      'fitfeed-mutant-uid',
      (rules) => rules
        .replace('&& !(uid() in legacyLikedByBefore())', '')
        .replace('&& (uid() in incoming().likedBy)', '')
        .replace(
          `&& incoming().likedBy.toSet().difference(legacyLikedByBefore().toSet())
               == [uid()].toSet()`,
          '&& true'
        ),
      async (weak) => {
        const db = asUser(weak, BOB, BOB_EMAIL).firestore();
        // The attack the real rules refuse. Under the weakened rule it lands,
        // which is what makes the passing test above meaningful.
        await assertSucceeds(
          updateDoc(doc(db, 'posts/post1'), {
            likesCount: increment(1),
            likedBy: arrayUnion('victim_uid'),
          })
        );
      }
    );
  });

  it('dropping the changed-key pin would let a caption ride along', async () => {
    await withWeakenedRules(
      'fitfeed-mutant-keys',
      (rules) => rules.replace(
        `return changedKeys().hasOnly(['likesCount', 'likedBy'])
          && changedKeys().hasAll(['likesCount', 'likedBy'])`,
        `return changedKeys().hasAll(['likesCount', 'likedBy'])`
      ),
      async (weak) => {
        const db = asUser(weak, BOB, BOB_EMAIL).firestore();
        await assertSucceeds(
          updateDoc(doc(db, 'posts/post1'), {
            likesCount: increment(1),
            likedBy: arrayUnion(BOB),
            content: 'hijacked caption',
          })
        );
      }
    );
  });

  it('dropping the size check would let the array be replaced wholesale', async () => {
    await withWeakenedRules(
      'fitfeed-mutant-size',
      (rules) => rules
        .replace(
          '&& incoming().likedBy.size() == legacyLikedByBefore().size() + 1',
          ''
        )
        .replace(
          `&& legacyLikedByBefore().toSet().difference(incoming().likedBy.toSet()).size() == 0`,
          '&& true'
        ),
      async (weak) => {
        const db = asUser(weak, BOB, BOB_EMAIL).firestore();
        // Carol is silently dropped from the array.
        await assertSucceeds(
          updateDoc(doc(db, 'posts/post1'), {
            likesCount: increment(1),
            likedBy: [BOB],
          })
        );
      }
    );
  });
});
