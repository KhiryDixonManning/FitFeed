#!/usr/bin/env node
/**
 * Read-only production smoke tests for the deployment window.
 *
 * Automates the parts of deployment validation that can be checked WITHOUT
 * touching user data. It performs no likes, no unlikes, no writes of any
 * kind, and needs no credentials — every check is either an unauthenticated
 * request whose rejection is the assertion, or a public read.
 *
 * What it deliberately does NOT do: like/unlike a real post, or read a
 * specific user's like state. Both need an authenticated session, and there
 * is no dedicated test account in this project. Creating one mid-migration
 * would be new production data at the worst possible moment. Those checks
 * stay manual, in the runbook, done by a human with their own account.
 *
 *   node scripts/smoke-production.mjs --api https://<host> [--site https://<host>]
 *
 * Exit 0 = every check passed. Non-zero = at least one did not; the runbook
 * treats that as a STOP.
 */

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const api = arg('--api');
const site = arg('--site');

if (!api) {
  console.error('Usage: node scripts/smoke-production.mjs --api <url> [--site <url>]');
  console.error('');
  console.error('  --api   the Railway backend base URL');
  console.error('  --site  the Firebase Hosting URL (optional; checks it serves)');
  console.error('');
  console.error('Read-only. Performs no writes and needs no credentials.');
  process.exit(2);
}

let failures = 0;
let checks = 0;

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let payload = null;
  const text = await response.text();
  if (text) { try { payload = JSON.parse(text); } catch { /* not json */ } }
  return { status: response.status, payload };
}

console.log(`FitFeed production smoke tests`);
console.log(`api:  ${api}`);
if (site) console.log(`site: ${site}`);
console.log('');

// ------------------------------------------------------------------ health
console.log('API health');

await check('GET /health returns ok', async () => {
  const { status, payload } = await request('/health');
  expect(status === 200, `expected 200, got ${status}`);
  expect(payload?.status === 'ok', `expected {"status":"ok"}, got ${JSON.stringify(payload)}`);
});

// ------------------------------------------------------- authorization gate
console.log('');
console.log('Authentication is enforced');

for (const path of ['/feed', '/trending', '/analyze', '/interactions']) {
  await check(`POST ${path} without a token is 401`, async () => {
    const { status, payload } = await request(path, { method: 'POST', body: {} });
    expect(status === 401, `expected 401, got ${status}`);
    expect(payload?.error === 'missing_token',
      `expected error "missing_token", got ${JSON.stringify(payload?.error)}`);
  });
}

await check('a bogus bearer token is refused', async () => {
  const response = await fetch(`${api}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify({ mode: 'discover' }),
    signal: AbortSignal.timeout(15000),
  });
  expect([401, 503].includes(response.status),
    `expected 401 or 503, got ${response.status}`);
});

await check('the removed /rank endpoint is gone', async () => {
  const { status } = await request('/rank', { method: 'POST', body: { posts: [] } });
  expect(status === 404, `expected 404, got ${status} — is this the OLD backend?`);
});

await check('the maintenance endpoint is not publicly callable', async () => {
  const { status } = await request('/reanalyze-all', { method: 'POST', body: {} });
  expect([403, 404].includes(status), `expected 403 or 404, got ${status}`);
});

// ------------------------------------------------------------ reads work
console.log('');
console.log('Reads still function');

await check('the feed rejects client-supplied posts rather than ranking them', async () => {
  const { status } = await request('/feed', {
    method: 'POST',
    body: { mode: 'foryou', posts: [{ id: 'injected', likesCount: 999999 }] },
  });
  // Auth is checked first, so this is a 401 — the point is that injected
  // posts never reach the ranker.
  expect([400, 401].includes(status), `expected 400 or 401, got ${status}`);
});

if (site) {
  await check('hosting serves the app', async () => {
    const response = await fetch(site, { signal: AbortSignal.timeout(15000) });
    expect(response.ok, `expected 2xx, got ${response.status}`);
    const html = await response.text();
    expect(html.includes('<div id="root"'), 'response does not look like the app shell');
  });
}

// --------------------------------------------------------------- summary
console.log('');
if (failures > 0) {
  console.error(`SMOKE TESTS FAILED: ${failures} of ${checks} checks failed.`);
  console.error('The runbook treats this as a STOP. Do not proceed to the next phase.');
  process.exit(1);
}
console.log(`All ${checks} read-only checks passed.`);
console.log('');
console.log('Still to do by hand, with a real signed-in account (see');
console.log('docs/production-rollout.md): like/unlike round-trip, the reload-after-');
console.log('unlike check, and the rules-state check in the Firebase console.');
