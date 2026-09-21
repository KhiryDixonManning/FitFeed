# Production rollout: the like migration

The runbook for taking FitFeed from the currently deployed build to this one.
Follow it in order. Every command is copy-pasteable and every step says what
"good" looks like before you move on.

Read [Like architecture](#like-architecture-what-is-true-at-each-stage) first
if you have not — the ordering constraints come from there, and improvising
around them breaks likes for live users.

> **Nothing here has been run.** No deployment has happened and no production
> migration has been executed. This document describes what to do, not what
> was done.

---

## Like architecture: what is true at each stage

### Legacy schema (currently in production)

```
posts/{postId}
  likesCount: number          denormalised counter
  likedBy:    string[]        every liker's uid, unbounded, on the post document
```

One write toggles both: `{ likesCount: increment(±1), likedBy: arrayUnion/arrayRemove(uid) }`.

### New schema (this branch)

```
posts/{postId}
  likesCount: number          denormalised counter, unchanged

posts/{postId}/likes/{uid}
  uid:       string           always equals the document id
  createdAt: string           ISO 8601
```

The document id **is** the liker's uid, so "one like per user per post" is a
property of the schema rather than something to enforce. The post document
stops growing with its audience.

### Answers to the questions that decide the rollout

| Question | Answer |
| --- | --- |
| Is historical `likedBy` migrated? | **Yes** — `migrate_likes.py --apply` creates a like document for every array entry. |
| Is `likedBy` dual-read? | **No.** The subcollection is the only source of truth. A fallback would be permanently wrong: no client can write `likedBy` under strict rules, so an unliked-after-migration post would show as liked forever. |
| Is `likedBy` deleted? | **No.** Retained as the rollback path. Retiring it is a separate change, step 11. |
| Source of truth for "did I like this?" | `posts/{postId}/likes/{uid}` exists. Backend: `attach_liked_by_me`. Client: `hasLiked` / `getLikedPostIds`. |
| Source of truth for `likesCount` | The counter field, kept honest by the rules (±1, only paired with the caller's own like document appearing or disappearing, checked against post-commit state). The like documents are the recount authority when they disagree. |
| Simultaneous likes by different users | Independent documents, independent `increment()`. Both land. Verified in `migration.lifecycle.test.ts` at 2 and 4 concurrent likers. |
| Duplicate / double-click | The transaction reads the like document before deciding, so the second call toggles rather than stacking. The counter always equals the document count. |
| Offline / retry | The write is a Firestore transaction; a retry re-reads and re-decides. A retried like is idempotent. Firestore's offline queue replays the transaction on reconnect. |
| Can counts drift? | **Yes, narrowly.** The rules permit deleting a like document *without* decrementing (the counter pairing is only enforced when the counter moves). Nothing in the app does this, but a console user could. Also possible from a partially applied legacy write during the window. |
| Is reconciliation needed? | **Yes, as maintenance.** `reconcile_likes.py` recounts and realigns. Dry run by default. |
| Post deletion cleanup | **Incomplete by design.** Firestore does not cascade-delete subcollections, and the rules only let a user delete their *own* like — so an author cannot clean up other people's. Orphaned likes are unreachable from the UI and cannot corrupt a count, but they accumulate. `reconcile_likes.py` sweeps them with the Admin SDK. |
| User deletion cleanup | **Not implemented.** There is no account-deletion flow. If one is added it must remove `posts/*/likes/{uid}`, `users/{uid}/**`, `saves/{uid}_*`, `follows/{uid}_*` and `userTasteState/{uid}`. Tracked in [transition-cleanup.md](transition-cleanup.md). |
| When can `isLegacyLikeToggle()` be removed? | See [the exact condition](#the-exact-condition-for-removing-islegacylikertoggle). |

### The exact condition for removing `isLegacyLikeToggle()`

All four must hold:

1. The strict rules are live in production (step 9 done).
2. `migrate_likes.py --verify` reports clean — every `likedBy` entry has a
   matching like document.
3. No client in the wild writes `likedBy`. In practice: hosting has served the
   new bundle for longer than any plausible tab lifetime, and Firestore usage
   metrics show no `permission-denied` writes against `posts/*`.
4. `reconcile_likes.py` reports no drift.

Until all four hold, the transitional file stays in the repository — it is the
rollback path. Removal is step 11, tracked in
[transition-cleanup.md](transition-cleanup.md).

---

## Before you start

```bash
cd fit-feed
npm ci
npm run verify                 # everything CI runs
npm run rehearse:migration     # walks this whole sequence against emulators
```

`rehearse:migration` is the important one. It runs strict → transitional →
backfill → new client → strict against the local emulator and fails loudly if
any step behaves differently from this document. It refuses to run against
anything but a local emulator.

Have ready:

- Firebase console open on the project, Firestore → Rules and → Usage.
- Railway open on both services.
- The output of a dry-run migration (step 1) so you know the expected numbers.

Pick a low-traffic window. Steps 7→8 are the only ones with a user-visible
gap, and you want it short.

---

## The sequence

### Step 1 — Dry-run the like migration

```bash
cd fit-feed/python-backend
python migrate_likes.py
```

**Good:** a count of like documents that *would* be created, and a list of any
post whose `likesCount` disagrees with its distinct liker count. Nothing is
written.

**Record the numbers.** You will compare against them in step 3.

### Step 2 — Apply the migration

```bash
python migrate_likes.py --apply
```

**Good:** created counts match the dry run. Idempotent — safe to re-run.
`likedBy` is untouched.

### Step 3 — Verify the migration

```bash
python migrate_likes.py --verify
```

**Good:** clean. Every post's like-document count equals `likesCount`.

**Do not continue until this is clean.** Everything downstream assumes the
subcollection is complete.

### Step 4 — Deploy indexes, and wait for them

```bash
cd fit-feed
firebase deploy --only firestore:indexes
```

Then **wait until every index reads Enabled** in the console. Index builds are
asynchronous; a query against a building index fails with
`FAILED_PRECONDITION`, which would turn the new backend into an error loop.

Needed: the collection-group `likes` index, both `analysisJobs` indexes, and
the `interactions` index.

### Step 5 — Deploy the transitional rules

```bash
npm run deploy:rules:transition
```

**Good:** the script prints the file, the policy and its consequence, confirms
the generated file is in sync, then deploys.

**What this buys:** the old client (which writes `likedBy`) and the new client
(which writes a like document) both work. Without it, one of them is broken
for the whole window.

### Step 6 — Smoke-test the deployed legacy client

Before changing anything else, confirm the clients already in the wild still
work under the new rules.

1. Open the live site in a fresh browser profile — this is the old bundle.
2. Like a post. **Good:** the heart fills and the count increments.
3. Unlike it. **Good:** it reverts.
4. Post a comment. **Good:** it appears and the count increments.
5. Console → Firestore → Usage. **Good:** no spike in permission-denied.

**If likes fail here, stop and roll back** (see
[Rollback](#rollback)). Everything after this point assumes the old client is
healthy.

### Step 7 — Deploy the Railway worker, then the web service

Worker first: on an empty queue it is a no-op, whereas web-first leaves new
uploads sitting at "Queued" with nothing draining them.

```
Railway → worker service → Deploy
Railway → web service    → Deploy
```

**Good:**

```bash
curl -s https://<api-host>/health                        # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<api-host>/feed   # 401
```

401, not 200 and not 500. The worker's logs should show it polling.

> The old client calls `/rank`, which this backend removes. Its feed is
> degraded from here until step 8. Keep the gap short.

### Step 8 — Deploy the frontend

```bash
cd fit-feed
npm run build
firebase deploy --only hosting
```

**Good:** hard-reload the live site; the bundle hash changes.

### Step 9 — Validate the new like path

On the live site, signed in as a **test account that liked something before
the migration**:

1. Open a post you liked previously. **Good:** the heart is filled — the
   backfill worked.
2. Unlike it. **Good:** it empties, the count drops.
3. Reload. **Good:** it is *still* empty. This is the check that catches the
   stale-array bug class — if the heart refills, the backend is reading
   `likedBy` somewhere it should not.
4. Like a new post, reload. **Good:** it stays filled.
5. Double-click a like rapidly. **Good:** the count moves by one, not two.
6. Open the same post in two tabs, like in one. **Good:** no drift.

Then check data integrity:

```bash
cd fit-feed/python-backend
python reconcile_likes.py            # dry run
```

**Good:** `drifted=0`. Any drift is reported per post; investigate before
continuing.

### Step 10 — Monitor

Leave the transitional rules in place for **at least 48 hours**, longer if
your users keep tabs open. Watch:

| Where | What is bad |
| --- | --- |
| Firebase console → Firestore → Usage | Rising permission-denied writes |
| Railway web logs | 4xx/5xx spikes on `/feed`, `/interactions` |
| Railway worker logs | Jobs failing, or the queue not draining |
| `python reconcile_likes.py` | Any `DRIFT` lines |

Re-run the migration once more near the end of the window:

```bash
python migrate_likes.py --apply
python migrate_likes.py --verify
```

This picks up likes the old client created *during* the window, which have an
array entry but no like document. **Clean verify required before step 11.**

### Step 11 — Switch back to strict rules

Only once all of:

- [ ] Hosting has served the new bundle for longer than any plausible tab life
- [ ] `migrate_likes.py --verify` is clean
- [ ] `reconcile_likes.py` reports no drift
- [ ] No permission-denied spike in the monitoring window

```bash
cd fit-feed
npm run deploy:rules:strict
```

### Step 12 — Verify legacy writes now fail

In the browser console on the live site, signed in:

```js
// Should be rejected with permission-denied.
const { doc, updateDoc, increment, arrayUnion } = await import(
  'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
await updateDoc(doc(window.__db, 'posts', '<a post id>'), {
  likesCount: increment(1), likedBy: arrayUnion('<your uid>'),
});
```

**Good:** `FirebaseError: Missing or insufficient permissions.`
**Bad:** it succeeds — you are still on the transitional rules. Re-run step 11.

Then confirm the app itself is unaffected: like and unlike a post through the
UI. **Good:** both work.

### Step 13 — Remove the transitional code

Not now. Follow [transition-cleanup.md](transition-cleanup.md), which lists
every artifact and the criteria for deleting it.

---

## Rollback

### Decision table

| Symptom | Stage | Action |
| --- | --- | --- |
| Legacy client cannot like | after step 5 | **R1** — transitional rules are wrong |
| New client broken, old still live | after step 8 | **R2** — roll back hosting |
| Backend erroring / feed down | after step 7 | **R3** — roll back the web service |
| Analysis not running | after step 7 | **R4** — worker only, not urgent |
| Likes fail after strict cutover | after step 11 | **R5** — reopen the window |
| Migration half-done | step 2 interrupted | **R6** — re-run it |

### R1 — Transitional rules behave incorrectly

```bash
# Fastest: Firebase console -> Firestore -> Rules -> History -> previous version
# -> Rollback. Instant, no build.
```

Then diagnose locally — never on production:

```bash
cd fit-feed
npm run rehearse:migration
npx firebase emulators:exec --only firestore,storage --project fitfeed-rules-test \
  "npx vitest run tests/rules/transition.rules.test.ts"
```

**Safe.** No data has changed; rules are pure policy.

### R2 — The new client breaks

```
Firebase console -> Hosting -> Release history -> previous release -> Rollback
```

Instant and needs no rebuild.

**Is rolling the client back safe once new like documents exist?** **Yes**, as
long as the transitional rules are still deployed — which at this stage they
are. The old client reads and writes `likedBy`, which was never deleted, so it
keeps working. Like documents created by the new client are simply invisible
to it.

The cost is a **split brain for the duration**: a like made on the new client
lives only in the subcollection, and a like made afterwards on the old client
lives only in the array. Both are preserved; neither is lost. Re-running
`migrate_likes.py --apply` after you roll forward again reconciles the array
side into the subcollection, and `reconcile_likes.py --apply` realigns
`likesCount`.

**Do not roll the client back after step 11 without first redeploying the
transitional rules** — the old client cannot write `likedBy` under strict
rules and its like button will fail. Order: rules first, then hosting.

### R3 — The API breaks

```
Railway -> web service -> Deployments -> previous -> Redeploy
```

Stateless. Safe at any point.

### R4 — The worker misbehaves

```
Railway -> worker service -> Stop
```

Jobs stay queued and drain when it returns. Nothing is lost; analysis is
delayed. Never urgent enough to justify rushing another step.

### R5 — Likes fail after the strict cutover

Someone is still on an old bundle.

```bash
cd fit-feed
npm run deploy:rules:transition
```

Reopens the legacy path in one command. Wait longer, re-verify, then retry
step 11.

### R6 — A partially completed migration

`migrate_likes.py` is idempotent and additive: it only ever *creates* like
documents that are missing and realigns counts. An interrupted run leaves a
partially backfilled but entirely consistent state.

```bash
python migrate_likes.py --apply     # resumes; skips what already exists
python migrate_likes.py --verify    # must be clean before continuing
```

There is no "undo" and none is needed — the migration adds data, and the
legacy array it was derived from is untouched.

### What must never be deleted during a rollback

| Never delete | Why |
| --- | --- |
| `likedBy` on post documents | The only record of a legacy like, and the entire rollback path for the old client. |
| `posts/*/likes/*` documents | The only record of likes made through the new client. Deleting them loses real user actions. |
| `firestore.transition.rules` | The one-command fix for R1 and R5. |
| `userTasteState/*` | Monotonic. Deleting it makes a stale cached taste vector look fresh. |
| `analysisJobs/*` | Carries the attempt budget. Deleting re-arms paid work. |
| Firebase Hosting release history | R2 depends on it. |

Safe to delete during rollback: **nothing**. Every rollback path here is a
redeploy or a re-run, not a deletion.

---

## Quick reference

```bash
# Rehearse everything locally, against emulators only
npm run rehearse:migration

# Migration
python migrate_likes.py                  # dry run
python migrate_likes.py --apply
python migrate_likes.py --verify

# Integrity
python reconcile_likes.py                # dry run: drift + orphaned likes
python reconcile_likes.py --apply

# Rules
npm run deploy:rules:transition
npm run deploy:rules:strict
npm run rules:check                      # generated file still in sync?
```
