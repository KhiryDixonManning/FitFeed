#!/usr/bin/env node
/**
 * Generate firestore.transition.rules from firestore.rules.
 *
 * The transitional policy exists for one deploy window only: the currently
 * deployed client writes likes as `likedBy: arrayUnion(uid)` alongside the
 * counter, which the strict rules refuse, while the new client writes a like
 * document, which the OLD rules refuse. The two clients need mutually
 * exclusive rule sets, and browser tabs keep running old JavaScript for hours
 * after a hosting deploy. See docs/deployment.md.
 *
 * Generating rather than hand-maintaining a second copy is the point. A
 * checked-in duplicate silently rots the first time somebody edits
 * firestore.rules; this file makes the transitional version a pure function of
 * the strict one plus one documented block, and `npm run rules:check` fails
 * if the committed output no longer matches.
 *
 *   node scripts/build-transition-rules.mjs          # write the file
 *   node scripts/build-transition-rules.mjs --check  # verify it is in sync
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const STRICT = resolve(here, '../firestore.rules');
const TRANSITION = resolve(here, '../firestore.transition.rules');

export const TRANSITION_MARKER = 'FITFEED_TRANSITIONAL_RULES';

// ---------------------------------------------------------------- the delta

// 1. A banner, so nobody mistakes this for the production policy.
const BANNER = `// =====================================================================
// ${TRANSITION_MARKER} - TEMPORARY. NOT THE PRODUCTION POLICY.
//
// GENERATED FILE. Do not edit by hand:
//     npm run rules:build
// It is firestore.rules plus exactly one extra allowance, described below.
//
// Deploy this ONLY during the like-migration window, between the backend
// deploy and the frontend deploy, then replace it with firestore.rules:
//     npm run deploy:rules:transition     # this file
//     npm run deploy:rules:strict         # firestore.rules, once clients drain
//
// Everything else - AI field protection, authorId immutability, comment
// counter invariants, interaction/profile/taste/analysis-job rules - is
// inherited unchanged from firestore.rules.
// =====================================================================

`;

// 2. The one extra allowance. Permits precisely the mutation the deployed
//    client performs and nothing wider.
const LEGACY_BLOCK = `
    // ------------------------------------------- TRANSITIONAL: legacy likes
    // ${TRANSITION_MARKER}
    //
    // The deployed client toggles a like as exactly:
    //     updateDoc(post, { likesCount: increment(±1),
    //                       likedBy: arrayUnion/arrayRemove(uid) })
    // and nothing else. This permits that shape and only that shape, so the
    // old client keeps working while tabs still hold old JavaScript.
    //
    // It does NOT reopen post updates: the changed-key set is pinned to the
    // two fields, the counter must step by exactly one, and the array must
    // differ by exactly the CALLER'S OWN uid. Replacing the array, touching
    // somebody else's uid, or smuggling another field alongside all fail.

    function legacyLikedByBefore() {
      return existing().get('likedBy', []);
    }

    // The array gained exactly the caller's own uid, and lost nothing.
    function legacyLikeAdded() {
      return incoming().likedBy is list
          && incoming().likedBy.size() <= 5000
          && incoming().likedBy.size() == legacyLikedByBefore().size() + 1
          && !(uid() in legacyLikedByBefore())
          && (uid() in incoming().likedBy)
          && incoming().likedBy.toSet().difference(legacyLikedByBefore().toSet())
               == [uid()].toSet()
          && legacyLikedByBefore().toSet().difference(incoming().likedBy.toSet()).size() == 0;
    }

    // The array lost exactly the caller's own uid, and gained nothing.
    function legacyLikeRemoved() {
      return incoming().likedBy is list
          && incoming().likedBy.size() == legacyLikedByBefore().size() - 1
          && (uid() in legacyLikedByBefore())
          && !(uid() in incoming().likedBy)
          && legacyLikedByBefore().toSet().difference(incoming().likedBy.toSet())
               == [uid()].toSet()
          && incoming().likedBy.toSet().difference(legacyLikedByBefore().toSet()).size() == 0;
    }

    function isLegacyLikeToggle() {
      return changedKeys().hasOnly(['likesCount', 'likedBy'])
          && changedKeys().hasAll(['likesCount', 'likedBy'])
          && incoming().likesCount is number
          && incoming().likesCount >= 0
          && ((incoming().likesCount == likesBefore() + 1 && legacyLikeAdded())
           || (incoming().likesCount == likesBefore() - 1 && legacyLikeRemoved()));
    }
`;

// 3. Where the allowance is wired in: one extra disjunct on the post update.
const STRICT_UPDATE = `      allow update: if isSignedIn()
        && (isAuthorContentEdit() || isOwnLikeToggle(postId) || isCommentCountStep(postId));`;

const TRANSITION_UPDATE = `      allow update: if isSignedIn()
        && (isAuthorContentEdit() || isOwnLikeToggle(postId) || isCommentCountStep(postId)
            // ${TRANSITION_MARKER}: removed by deploy:rules:strict.
            || isLegacyLikeToggle());`;

// The anchor the legacy helpers are inserted before.
const POSTS_MATCH = `    match /posts/{postId} {`;

/** Line endings differ between a Windows checkout and a Linux CI runner, so
 *  every comparison here happens on LF-normalised text. */
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
function lf(text) {
  return text.split(CR + LF).join(LF);
}

export function buildTransitionRules(rawStrictSource) {
  const strictSource = lf(rawStrictSource);
  if (strictSource.includes(TRANSITION_MARKER)) {
    throw new Error('firestore.rules already contains the transitional marker; ' +
      'the strict file must stay strict.');
  }
  if (!strictSource.includes(STRICT_UPDATE)) {
    throw new Error('Could not find the posts update rule in firestore.rules. ' +
      'It changed shape - update scripts/build-transition-rules.mjs to match.');
  }
  if (!strictSource.includes(POSTS_MATCH)) {
    throw new Error('Could not find the posts match block in firestore.rules.');
  }

  let out = strictSource.replace(POSTS_MATCH, LEGACY_BLOCK + LF + POSTS_MATCH);
  out = out.replace(STRICT_UPDATE, TRANSITION_UPDATE);
  return BANNER + out;
}

// ------------------------------------------------------------------ driver

function main() {
  const strict = readFileSync(STRICT, 'utf8');
  const expected = buildTransitionRules(strict);

  if (process.argv.includes('--check')) {
    let actual;
    try {
      actual = readFileSync(TRANSITION, 'utf8');
    } catch {
      console.error('firestore.transition.rules is missing. Run: npm run rules:build');
      process.exit(1);
    }
    if (lf(actual) !== lf(expected)) {
      console.error(
        'firestore.transition.rules is out of sync with firestore.rules.\n' +
        'Someone edited one without regenerating the other. Run: npm run rules:build'
      );
      process.exit(1);
    }
    console.log('firestore.transition.rules is in sync with firestore.rules.');
    return;
  }

  writeFileSync(TRANSITION, expected);
  console.log('Wrote firestore.transition.rules from firestore.rules.');
}

if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('build-transition-rules.mjs')) {
  main();
}
