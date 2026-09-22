import { beforeAll, afterAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { ALICE, ALICE_EMAIL, BOB, BOB_EMAIL, asUser, makeTestEnv } from './setup';

let env: RulesTestEnvironment;

const jpeg = (bytes = 1024) =>
  new Uint8Array(bytes).fill(0xff);

const meta = { contentType: 'image/jpeg' };

beforeAll(async () => {
  env = await makeTestEnv();
});

afterAll(async () => {
  await env.cleanup();
});

describe('storage: post images', () => {
  it('an anonymous user cannot upload', async () => {
    const storage = env.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(storage, `posts/${ALICE}/a.jpg`), jpeg(), meta));
  });

  it('a user can upload into their own folder', async () => {
    const storage = asUser(env, ALICE, ALICE_EMAIL).storage();
    await assertSucceeds(uploadBytes(ref(storage, `posts/${ALICE}/a.jpg`), jpeg(), meta));
  });

  it('a user CANNOT upload into another user folder', async () => {
    const storage = asUser(env, BOB, BOB_EMAIL).storage();
    await assertFails(uploadBytes(ref(storage, `posts/${ALICE}/evil.jpg`), jpeg(), meta));
  });

  it('non-image uploads are refused', async () => {
    const storage = asUser(env, ALICE, ALICE_EMAIL).storage();
    await assertFails(
      uploadBytes(ref(storage, `posts/${ALICE}/payload.html`), jpeg(), {
        contentType: 'text/html',
      })
    );
    await assertFails(
      uploadBytes(ref(storage, `posts/${ALICE}/payload.pdf`), jpeg(), {
        contentType: 'application/pdf',
      })
    );
  });

  it('oversized uploads are refused', async () => {
    const storage = asUser(env, ALICE, ALICE_EMAIL).storage();
    // 11 MB, just past the 10 MB ceiling.
    await assertFails(
      uploadBytes(ref(storage, `posts/${ALICE}/huge.jpg`), jpeg(11 * 1024 * 1024), meta)
    );
  }, 30000);

  it('signed-in users can read post images', async () => {
    const owner = asUser(env, ALICE, ALICE_EMAIL).storage();
    await uploadBytes(ref(owner, `posts/${ALICE}/readable.jpg`), jpeg(), meta);
    const reader = asUser(env, BOB, BOB_EMAIL).storage();
    await assertSucceeds(getDownloadURL(ref(reader, `posts/${ALICE}/readable.jpg`)));
  });
});

describe('storage: avatars', () => {
  it('a user can upload their own avatar', async () => {
    const storage = asUser(env, ALICE, ALICE_EMAIL).storage();
    await assertSucceeds(uploadBytes(ref(storage, `avatars/${ALICE}/me.jpg`), jpeg(), meta));
  });

  it('a user cannot overwrite another user avatar', async () => {
    const storage = asUser(env, BOB, BOB_EMAIL).storage();
    await assertFails(uploadBytes(ref(storage, `avatars/${ALICE}/me.jpg`), jpeg(), meta));
  });
});
