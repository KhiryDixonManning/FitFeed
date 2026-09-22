#!/usr/bin/env node
/**
 * Deploy Firestore rules, strict or transitional, without anyone hand-editing
 * a rules file.
 *
 *   node scripts/deploy-rules.mjs strict       # firestore.rules
 *   node scripts/deploy-rules.mjs transition   # firestore.transition.rules
 *
 * The transitional policy is temporary and permits a legacy write the strict
 * one refuses, so shipping the wrong one is a security regression in one
 * direction and an outage in the other. Every check below exists to make that
 * mistake loud rather than silent:
 *
 *   - the transitional file must be in sync with its generator
 *   - the strict file must NOT contain the transitional marker
 *   - the transitional file MUST contain it
 *   - the mode is echoed, with its consequence, before anything is deployed
 *
 * Nothing here is deployed without an explicit mode argument. There is no
 * default on purpose.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRANSITION_MARKER } from './build-transition-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const MODES = {
  strict: {
    file: 'firestore.rules',
    config: null,
    marker: false,
    describe: 'the production policy. Legacy likedBy writes are REFUSED.',
    warn: 'Old clients still holding stale JavaScript will fail to like posts.',
  },
  transition: {
    file: 'firestore.transition.rules',
    config: 'firebase.transition.json',
    marker: true,
    describe: 'TEMPORARY. Permits the one legacy likedBy write the deployed client makes.',
    warn: 'Replace it with `npm run deploy:rules:strict` once old clients have drained.',
  },
};

const mode = process.argv[2];
const spec = MODES[mode];

if (!spec) {
  console.error('Nothing was deployed: this command requires an explicit mode.');
  console.error('');
  console.error('  npm run deploy:rules:transition   firestore.transition.rules');
  console.error('                                    migration window ONLY - permits the');
  console.error('                                    legacy likedBy write');
  console.error('  npm run deploy:rules:strict       firestore.rules');
  console.error('                                    the production policy');
  console.error('');
  console.error('Rules are only one step. Indexes, the Railway services and hosting');
  console.error('deploy separately and IN ORDER, and the like migration runs before any');
  console.error('of them. Deploying them together will break likes for live clients.');
  console.error('');
  console.error('Read docs/production-rollout.md before deploying anything.');
  console.error('Rehearse locally first: npm run rehearse:migration');
  process.exit(2);
}

// 1. The generated file must match its generator, or the thing on disk is not
//    the thing anybody reviewed.
try {
  execFileSync(process.execPath, [resolve(here, 'build-transition-rules.mjs'), '--check'], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  console.error('');
  console.error('Refusing to deploy: the transitional rules are out of sync.');
  process.exit(1);
}

// 2. The file being deployed must be the one the mode claims.
const contents = readFileSync(resolve(root, spec.file), 'utf8');
const hasMarker = contents.includes(TRANSITION_MARKER);

if (spec.marker && !hasMarker) {
  console.error(`Refusing to deploy: ${spec.file} does not carry the transitional marker.`);
  process.exit(1);
}
if (!spec.marker && hasMarker) {
  console.error(`Refusing to deploy: ${spec.file} carries the transitional marker.`);
  console.error('The strict policy must not contain the legacy allowance.');
  process.exit(1);
}

// 3. Say plainly what is about to happen.
console.log('');
console.log(`Deploying Firestore rules: ${spec.file}`);
console.log(`  ${spec.describe}`);
console.log(`  ${spec.warn}`);
console.log('');

const args = ['firebase', 'deploy', '--only', 'firestore:rules'];
if (spec.config) args.push('--config', spec.config);

execFileSync('npx', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
