#!/usr/bin/env node
/**
 * The hygiene checks from CI, runnable locally.
 *
 * Mirrors the `hygiene` job in .github/workflows/ci.yml so a developer can
 * find a problem before pushing rather than after. Operates on what git
 * TRACKS, not on what happens to be on disk - an ignored file is fine, a
 * committed one is not.
 */
import { execFileSync } from 'node:child_process';

let failures = 0;

function fail(message, detail) {
  failures += 1;
  console.error(`FAIL  ${message}`);
  if (detail) for (const line of detail.slice(0, 20)) console.error(`        ${line}`);
}

function pass(message) {
  console.log(`ok    ${message}`);
}

function tracked() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const files = tracked();

// --- 1. no dependency or build output committed -----------------------------
const junkPatterns = [
  'node_modules/', 'dist/', 'test-results/', 'playwright-report/',
  'coverage/', '__pycache__/', 'venv/',
];
for (const pattern of junkPatterns) {
  const hits = files.filter((f) => f === pattern || f.includes(`/${pattern}`) || f.startsWith(pattern));
  if (hits.length > 0) fail(`tracked files under ${pattern} (${hits.length})`, hits);
}
if (failures === 0) pass('no dependency or build output is tracked');

// --- 2. no credential files committed ---------------------------------------
const before = failures;
const credentialPatterns = ['serviceAccountKey.json', '.pem', 'credentials.json'];
for (const pattern of credentialPatterns) {
  const hits = files.filter((f) => f.includes(pattern));
  if (hits.length > 0) fail(`tracked credential-shaped file matching ${pattern}`, hits);
}
const envFiles = files.filter((f) => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith('.env.example'));
if (envFiles.length > 0) fail('tracked .env file', envFiles);
if (failures === before) pass('no credential files are tracked');

// --- 3. secret-shaped strings in tracked content ----------------------------
// Narrow, high-signal patterns on purpose: a scanner that cries wolf is a
// scanner someone turns off.
const SECRET_PATTERNS = [
  'sk-ant-[A-Za-z0-9_-]{16,}',
  'AIza[0-9A-Za-z_-]{35}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  '"private_key"[[:space:]]*:',
  'ghp_[A-Za-z0-9]{36}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
];
// One documented exception: fit-feed/firebase.ts holds the Firebase *Web*
// config, whose apiKey is a public client identifier shipped in every browser
// bundle, not a credential. It is allowlisted by exact path and shape, so an
// AIza... key appearing anywhere else still fails the scan.
const PUBLIC_WEB_CONFIG = /^firebase\.ts:\d+:\s*apiKey: "AIza[0-9A-Za-z_-]{35}",$/;

const args = ['grep', '-nIE'];
for (const pattern of SECRET_PATTERNS) args.push('-e', pattern);
args.push('--', '.', ":(exclude)*.lock", ':(exclude)package-lock.json');

try {
  const found = execFileSync('git', args, { encoding: 'utf8' });
  const real = found
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))   // CRLF checkouts on Windows
    .filter(Boolean)
    .filter((line) => !PUBLIC_WEB_CONFIG.test(line));
  if (real.length > 0) fail('secret-shaped string in tracked content', real);
  else pass('no secret-shaped strings in tracked content (public web config allowlisted)');
} catch (error) {
  // git grep exits 1 when nothing matched, which is the outcome we want.
  if (error.status === 1) pass('no secret-shaped strings in tracked content');
  else fail(`secret scan could not run: ${error.message}`);
}

// --- 4. the test suite cannot make a paid model call ------------------------
try {
  const conftest = execFileSync(
    'git', ['show', 'HEAD:fit-feed/python-backend/tests/conftest.py'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (conftest.includes('os.environ.pop("ANTHROPIC_API_KEY", None)')) {
    pass('ANTHROPIC_API_KEY is stripped before any test import');
  } else {
    fail('conftest.py no longer strips ANTHROPIC_API_KEY');
  }
} catch {
  // Not yet committed; check the working copy instead.
  const { readFileSync } = await import('node:fs');
  const conftest = readFileSync('python-backend/tests/conftest.py', 'utf8');
  if (conftest.includes('os.environ.pop("ANTHROPIC_API_KEY", None)')) {
    pass('ANTHROPIC_API_KEY is stripped before any test import (working copy)');
  } else {
    fail('conftest.py no longer strips ANTHROPIC_API_KEY');
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} hygiene check(s) failed.`);
  process.exit(1);
}
console.log('All hygiene checks passed.');
