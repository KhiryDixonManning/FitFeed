import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

// package.json sets "type": "module", so __dirname does not exist here.
const here = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ID = 'fitfeed-rules-test';

/** Reads a rules file from the project root. */
export function readRules(name: string): string {
  return readFileSync(resolve(here, '../..', name), 'utf8');
}

export const ALICE = 'alice_uid';
export const ALICE_EMAIL = 'alice@example.com';
export const BOB = 'bob_uid';
export const BOB_EMAIL = 'bob@example.com';

export async function makeTestEnv(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readRules('firestore.rules'),
    },
    storage: {
      host: '127.0.0.1',
      port: 9199,
      rules: readRules('storage.rules'),
    },
  });
}

/**
 * An environment running an arbitrary Firestore rules source, under its own
 * project id.
 *
 * Rules are stored per project in the emulator, so a second rule set needs a
 * second project or it would overwrite the first one's policy mid-run. Used
 * for the transitional rules and for the deliberately weakened variants the
 * mutation tests need.
 */
export async function makeRulesEnv(
  projectId: string,
  rules: string
): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId,
    firestore: { host: '127.0.0.1', port: 8080, rules },
  });
}

/** A signed-in context whose token carries an email, like a real password user. */
export function asUser(env: RulesTestEnvironment, uid: string, email: string) {
  return env.authenticatedContext(uid, { email, email_verified: true });
}

/** A valid post document as the app actually writes it. */
/** A Storage download URL under a given user's own upload prefix. */
export function storageUrlFor(uid: string, file = '1.jpg') {
  return `https://firebasestorage.googleapis.com/v0/b/fitfeed-67ee8.firebasestorage.app/o/posts%2F${uid}%2F${file}?alt=media`;
}

export function postDoc(authorId: string, overrides: Record<string, unknown> = {}) {
  return {
    authorId,
    content: 'a caption',
    imageUrl: storageUrlFor(authorId),
    category: 'streetwear',
    outfitBreakdown: '',
    likesCount: 0,
    commentsCount: 0,
    likedBy: [],
    createdAt: new Date(),
    analysisStatus: 'pending',
    ...overrides,
  };
}

export function commentDoc(authorId: string, authorEmail: string, postId = 'post1') {
  return {
    postId,
    authorId,
    authorEmail,
    content: 'nice fit',
    createdAt: new Date().toISOString(),
  };
}
