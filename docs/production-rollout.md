# Production rollout: the like migration

The operator runbook. Nine phases, in order. Every phase states its commands,
what "good" looks like, the conditions that mean **STOP**, and its rollback
route.

> **Nothing here has been run.** No deployment has happened and no production
> migration has been executed. This describes what to do, not what was done.

**Rehearse first.** `npm run rehearse:migration` walks this whole sequence
against the local emulator and fails loudly if any step behaves differently
from this document. It refuses to run against anything but a local emulator.

**Contents:** [A Prerequisites](#phase-a--pre-deploy-prerequisites) ·
[B Backup](#phase-b--backuprecovery-readiness) ·
[C Dry run](#phase-c--migration-dry-run) ·
[D Transitional rules](#phase-d--transitional-rules) ·
[E Cutover](#phase-e--backendclient-cutover) ·
[F Observation](#phase-f--48h-observation-window) ·
[G Legacy tail](#phase-g--final-legacy-tail-handling) ·
[H Strict rules](#phase-h--strict-rules) ·
[I Cleanup](#phase-i--transitional-code-cleanup) ·
[Rollback](#rollback) · [Architecture](#like-architecture-reference)

---

## Phase A — Pre-deploy prerequisites

**Actions**

```bash
cd fit-feed
npm ci
npm run verify                 # everything CI runs
npm run rehearse:migration     # the whole sequence, against emulators
```

Have open and ready:

- Firebase console → Firestore → **Rules**, **Usage**, **Data**
- Railway → both services → **Deployments** and **Logs**
- A signed-in test account **that has liked at least one post already** —
  you need it in Phase E to prove the backfill worked.

**Expected result** — `npm run verify` green; rehearsal prints
`Rehearsal passed`.

**STOP if**
- Anything in `verify` is red.
- The rehearsal fails any check.
- You do not have an account with a pre-existing like. Without it the most
  important validation in Phase E cannot be performed.

**Rollback route** — none needed; nothing has changed.

---

## Phase B — Backup/recovery readiness

**This phase is a hard gate. Do not enter Phase C without a verified backup.**

### What must be backed up

| Data | Why |
| --- | --- |
| `posts` (incl. `likes` subcollection) | The migration writes here |
| `comments`, `saves`, `follows` | Related user data |
| `users`, `publicProfiles`, `userPreferences` | Profiles |
| `userTasteState`, `userTasteVectors` | Recommendation state |
| `analysisJobs` | Attempt budgets |
| Auth accounts | Separate export; see below |

Storage objects (post images) are **not** included and are not touched by the
migration.

### Option 1 — Google managed backup (preferred, needs Blaze)

Requires: **Blaze billing**, the `gcloud` CLI, a GCS bucket, and the
`datastore.databases.export` IAM permission (roles/datastore.importExportAdmin).

```bash
gcloud config set project fitfeed-67ee8
gcloud firestore export gs://<your-bucket>/pre-like-migration-$(date +%Y%m%d)
gcloud firestore operations list        # wait for DONE
```

Restore: `gcloud firestore import gs://<bucket>/<path>`.

The Firebase CLI **has no one-shot `firestore:export`** — it offers scheduled
backups only (`firebase firestore:backups:schedules:create`, also Blaze) and
`firebase firestore:databases:restore`. A schedule is not a pre-migration
snapshot; use `gcloud` for that.

### Option 2 — Repository export (any tier, no gcloud, no GCS)

If the project is on **Spark**, or `gcloud` is not installed, or you lack the
IAM permission, neither managed option is available. Use the export shipped in
this repository, which needs nothing beyond the Admin SDK credentials the
backend already uses:

```bash
cd fit-feed
npm run backup:firestore -- --out ../backups/$(date +%Y%m%d)-pre-migration
npm run backup:verify    -- ../backups/$(date +%Y%m%d)-pre-migration
```

**Where it goes:** a directory you choose, outside the repository (`backups/`
is gitignored). Put it somewhere durable — not only your laptop.

**How completion is verified:** `--verify` re-reads every file, checks the
SHA-256 in the manifest, confirms the line count matches, and parses every
line. It exits non-zero on a missing, short, corrupted or unparseable file.
A truncated export cannot pass.

**How it restores:** the format is newline-delimited JSON, one file per
collection, with `{"id": ..., "data": ...}` per line. Restoring is a
deliberate, reviewed operation — write the loop against the Admin SDK at the
time, targeting only the collections you actually need. **There is no
one-command restore on purpose**: an unreviewed bulk restore is how a partial
outage becomes a total one.

**Its limits, stated plainly:** not point-in-time consistent across
collections (it reads them in sequence), no PITR, and it excludes Storage and
Auth. For this migration that is acceptable — the migration only *adds* like
documents and adjusts a counter, so the recovery that matters is the targeted
rollback in [Rollback](#rollback), and this snapshot is the backstop for the
catastrophic case.

### Auth accounts (either option)

```bash
cd fit-feed
npx firebase auth:export ../backups/$(date +%Y%m%d)-auth.json --format=json
```

Works on any tier.

**Expected result** — a backup directory or GCS path, and a **verification
that passed**.

**STOP if**
- `--verify` fails, or the `gcloud` operation did not reach `DONE`.
- The backup lives only on the machine running the migration.
- You have not confirmed *how* you would restore it.

**Rollback route** — none needed; nothing has changed.

---

## Phase C — Migration dry run

**Actions**

```bash
cd fit-feed/python-backend
python migrate_likes.py
```

**Expected result** — a plan: how many like documents *would* be created, any
`ANOMALY` lines (duplicate array entries), any `RECONCILE` lines. **Nothing is
written.**

**Record the numbers.** You compare against them in Phase G.

**STOP if**
- The created count is wildly different from your expectation of the data.
- Anomalies appear on more posts than you can explain.

**Rollback route** — none needed; a dry run writes nothing.

---

## Phase D — Transitional rules

**Actions**

```bash
cd fit-feed/python-backend
python migrate_likes.py --apply
python migrate_likes.py --verify

cd ..
firebase deploy --only firestore:indexes     # then WAIT for Enabled
npm run deploy:rules:transition
```

`--apply` creates a like document per legacy array entry and records the
`likedByMigrated` watermark. `likedBy` is **not** modified.

Index builds are asynchronous. Wait until every index reads **Enabled** in the
console — a query against a building index fails `FAILED_PRECONDITION`, which
would turn the new backend into an error loop.

**Expected result**
- `--verify` reports `VERIFY OK`.
- All indexes Enabled.
- The rules deploy prints the file and policy before shipping.

**Now smoke-test the client that is still live** (it is the old bundle):

1. Open the live site in a fresh browser profile.
2. Like a post → heart fills, count increments.
3. Unlike it → reverts.
4. Post a comment → appears, count increments.
5. Console → Firestore → Usage → no permission-denied spike.

**STOP if**
- `--verify` is not clean. Everything downstream assumes the subcollection is
  complete.
- Any index is still building.
- The legacy client cannot like. → **R1**

**Rollback route** — **R1** (rules) and **R6** (migration).

---

## Phase E — Backend/client cutover

Worker first (a no-op on an empty queue), then web, then hosting. Keep steps
close together.

**Actions**

```
Railway → worker service → Deploy
Railway → web service    → Deploy
```

```bash
cd fit-feed
npm run smoke:production -- --api https://<api-host>
npm run build && firebase deploy --only hosting
npm run smoke:production -- --api https://<api-host> --site https://<site-host>
```

`smoke:production` is read-only: it performs no likes, no writes and needs no
credentials. It checks health, that every protected route rejects an
unauthenticated call, that the removed `/rank` really is gone, that the
maintenance endpoint is not public, and that hosting serves the app shell.

**Then validate the like path by hand**, signed in as the account that liked
something before the migration:

1. Open a post you liked previously → **the heart is filled.** The backfill
   worked.
2. Unlike it → empties, count drops.
3. **Reload.** → **still empty.** This is the check that catches the
   stale-array class of bug. If the heart refills, something is reading
   `likedBy` that should not be.
4. Like a new post, reload → stays filled.
5. Double-click a like → the count moves by one, not two.
6. Same post in two tabs, like in one → no drift.

```bash
cd python-backend && python reconcile_likes.py      # dry run
```

**Expected result** — smoke tests all pass; every manual check behaves as
above; `reconcile_likes.py` reports `drifted=0`.

**STOP if**
- Any smoke check fails.
- The heart refills after reload (step 3). That is a correctness bug, not
  cosmetic. → **R2**
- Drift appears immediately.

**Rollback route** — **R2** (hosting), **R3** (web), **R4** (worker).

### What users experience between the web and hosting deploys

The gap is real but mild, and it is **cosmetic, not destructive**.

The deployed client calls `/rank` and `/trending` inside `try/catch` blocks
that fall back to `return posts`:

```js
} catch (error) {
    console.warn("Python API unavailable, falling back to unranked feed:", error);
    return posts;
}
```

So when the new backend answers `404` (for the removed `/rank`) or `401`
(those old calls send no auth header), the old client catches it and renders
**the unranked feed**. Concretely:

| | |
| --- | --- |
| **What users see** | Posts in Firestore order instead of ranked order. No error, no empty state. |
| **Duration** | Minutes — the length of one `npm run build && firebase deploy --only hosting`. |
| **Requests that fail** | `POST /rank` → 404; `POST /trending` → 401. Both are caught. |
| **Existing tabs** | Unaffected beyond the ordering. They keep working; likes and comments still succeed under the transitional rules. |
| **Data loss** | **None.** Only reads fail, and they fail into a fallback. No write is attempted on this path. |
| **Continue signal** | Feeds render (unranked is fine); like/comment still work; no permission-denied spike. |
| **Rollback signal** | Likes or comments failing, or blank/erroring feeds — that is not this gap and means something else is wrong. → **R3** |

**Could the gap be closed?** Only by re-adding a `/rank` shim to the new
backend — more transitional code to build, test, deploy and later remember to
delete, in order to fix an ordering difference the client already handles by
design, for a few minutes. That is more risk than it removes, so the
architecture is left alone.

---

## Phase F — 48h observation window

Leave the transitional rules in place **at least 48 hours**, longer if your
users keep tabs open.

### What to watch, and where

Existing Firebase and Railway tooling is sufficient. No monitoring platform is
added for this migration.

| Signal | Where | Investigate at | Roll back at |
| --- | --- | --- | --- |
| **Permission-denied spike** | Firebase console → Firestore → Usage | Any sustained rise above baseline | A step change coinciding with a deploy → **R1**/**R5** |
| **Failed like/unlike** | Railway web logs; user reports; browser console | Any `permission-denied` on `posts/*` | Reproducible failure on a current client → **R2** |
| **Migration errors** | `migrate_likes.py` output | Any `ANOMALY` | Any `MISMATCH` or `UNMIGRATED` at Phase G → **R6** |
| **Counter drift** | `python reconcile_likes.py` daily | Any `DRIFT` line | Drift growing run over run → investigate before **R** anything |
| **Reconciliation failure** | Its exit code (non-zero on failure) | Non-zero exit | Repeated non-zero → stop the window |
| **Backend exceptions** | Railway → web → Logs | Any 5xx | Sustained 5xx on `/feed` → **R3** |
| **Worker failures** | Railway → worker → Logs | Jobs not draining; repeated `STALE` | Queue growing unboundedly → **R4** |
| **Frontend deploy failure** | `firebase deploy` output; Hosting release list | A release that did not publish | Site serving the wrong bundle → **R2** |

### Daily during the window

```bash
cd fit-feed/python-backend
python reconcile_likes.py          # dry run; expect drifted=0, orphaned=0
```

**Expected result** — flat permission-denied, no 5xx trend, `drifted=0`.

**STOP if** — any "Roll back at" column is met.

---

## Phase G — Final legacy-tail handling

Two things happened during the window that only the Admin SDK can resolve.
Old clients wrote `likedBy` entries with no like document, and old clients
**unliked** posts without being able to delete the like document underneath.
This phase closes both.

**Run this after the observation window has closed and before Phase H.**

### Actions — run in this order

```bash
cd fit-feed/python-backend

# 1. Review the plan. Writes nothing.
python migrate_likes.py

# 2. Backfill tail-window likes AND prune stale documents.
#    --prune-stale is REQUIRED here. See below.
python migrate_likes.py --apply --prune-stale

# 3. Prove the result.
python migrate_likes.py --verify

# 4. Reconcile counters and sweep orphans from deleted posts.
python reconcile_likes.py
python reconcile_likes.py --apply        # if step 4's dry run reported anything
```

### `--prune-stale` is required, not optional

The flag is opt-in at the CLI so that no routine run can delete data by
accident. **The production migration must pass it at this point**, because
without it one case stays permanently wrong.

An old client can unlike: the transitional rules permit
`{ likesCount: increment(-1), likedBy: arrayRemove(uid) }`. That removes the
array entry and decrements the counter, but the old client cannot touch
`posts/{id}/likes/{uid}` — no rule lets any client delete another
representation of the like. So the state becomes:

```
uid in M       (the migration backfilled them)
uid not in L   (they unliked on the old client)
uid in D       (the document they could not delete)
```

The new client reads **D**. Without the prune, a user who unliked still sees
the post as liked, forever, with no way to clear it — the mirror image of the
resurrection bug the watermark fixes. `--prune-stale` deletes exactly those
documents, and the counter then follows the documents.

`test_migration_lifecycle_e2e.py::test_without_prune_the_user_stays_liked`
asserts this failure mode directly, so the requirement cannot quietly lapse.

### Why this timing is safe

The prune deletes a like document whenever `uid in M and uid not in L`. That
inference — "they left the array, so they unliked" — is only sound once **no
client can still be writing `likedBy`**:

- **Too early** (during the window) an old client could unlike and re-like
  moments later. Pruning between the two would delete a document the user is
  about to want back. Running after the observation window closes means old
  clients have drained, so `L` has stopped moving.
- **Too late** (after Phase H) is harmless but pointless: strict rules already
  froze `likedBy`, and those users would have spent the whole interval
  incorrectly shown as liked.

So: **after the window, before strict rules.** At that point `L` is stable,
every difference between `M` and `L` is a settled decision, and the prune
resolves it exactly once.

### What the four outcomes are

| State | Meaning | Phase G does |
| --- | --- | --- |
| in `L`, not in `M`, no doc | tail-window legacy like | **creates** the document |
| in `M`, in `L`, no doc | unliked on the **new** client | **leaves it removed** (`PRESERVE`) |
| in `M`, not in `L`, doc exists | unliked on an **old** client | **prunes** the document (`STALE`) |
| in `M`, in `L`, doc exists | still liked, e.g. unliked then re-liked | **leaves it alone** |

Together these make it impossible for a new-client unlike to be resurrected,
an old-client unlike to remain liked, a legitimate tail-window like to be
lost, or the counter to diverge from the documents.

**Expected result**
- `VERIFY OK`.
- `CREATE` counts match the step-1 dry run.
- `PRESERVE` lines for new-client removals, `STALE` lines for the pruned ones.
- `reconcile_likes.py` reports `drifted=0`, `orphaned=0`.

**STOP if**
- `--verify` is not clean.
- `CREATE` counts are far above the dry run — investigate before applying.
- `STALE` counts are implausibly large relative to your active user base;
  that would suggest something other than old-client unlikes is deleting
  array entries.

**Rollback route** — **R6**. Note the prune is the one genuinely destructive
step in the whole rollout: it deletes like documents. The Phase B backup is
the reference if you need to reconstruct them, and step 1's dry run tells you
exactly how many will go before you commit to it.

---

## Phase H — Strict rules

**Only once all of these hold:**

- [ ] Hosting has served the new bundle longer than any plausible tab life
- [ ] Phase G `--verify` clean
- [ ] `reconcile_likes.py` reports no drift
- [ ] No permission-denied spike during Phase F

**Actions**

```bash
cd fit-feed
npm run deploy:rules:strict
```

**Verify legacy writes now fail.** In the browser console on the live site,
signed in, attempt the legacy mutation against a post:

```js
// Expect: FirebaseError: Missing or insufficient permissions.
const { doc, updateDoc, increment, arrayUnion } = await import(
  'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js');
await updateDoc(doc(window.__db, 'posts', '<a post id>'), {
  likesCount: increment(1), likedBy: arrayUnion('<your uid>'),
});
```

Then confirm the app is unaffected: like and unlike through the UI.

**Expected result** — the console attempt is rejected; the UI like/unlike
round-trip works.

**STOP if**
- The console attempt **succeeds** → you are still on transitional rules.
  Re-run the deploy.
- UI likes fail → someone is still on an old bundle. → **R5**

**Rollback route** — **R5**.

---

## Phase I — Transitional-code cleanup

Not now. Follow [transition-cleanup.md](transition-cleanup.md), which lists
every temporary artifact, the five criteria for removing it, and the order —
the `likedBy` data goes last because it is the only irreversible step.

---

## Rollback

For each path: the CLI command where a reliable one exists, the provider UI
action where it does not, and the verification that proves it worked.

| Symptom | Phase | Route |
| --- | --- | --- |
| Legacy client cannot like | D | **R1** |
| New client broken | E | **R2** |
| Backend erroring / 5xx | E | **R3** |
| Analysis not running | E | **R4** |
| Likes fail after strict cutover | H | **R5** |
| Migration interrupted / partial | C, D, G | **R6** |

### R1 — Transitional rules behave incorrectly

**No reliable CLI rollback.** The Firebase CLI can deploy a rules file but
cannot roll back to a previously published version; `firestore:databases:restore`
restores *data*, not rules.

**Provider UI:** Firebase console → Firestore Database → **Rules** → **History**
→ select the version **immediately below** the one timestamped at your Phase D
deploy → **Rollback**.

*Confirming you picked the right one:* the console shows each version's publish
time and a diff. The correct target is the last version whose source does
**not** contain `FITFEED_TRANSITIONAL_RULES`. Check the diff before confirming.

**CLI alternative** (cleaner, and preferred if the repo is to hand):

```bash
cd fit-feed
git stash                                  # if you have local edits
npm run deploy:rules:strict                # republish the known-good strict file
```

**Verify:** console → Rules → the active version no longer contains
`FITFEED_TRANSITIONAL_RULES`. Then re-test a like on a current client.

**Safe?** Yes — no data changed. Rules are pure policy.

Diagnose locally, never on production:

```bash
npm run rehearse:migration
npx firebase emulators:exec --only firestore,storage --project fitfeed-rules-test \
  "npx vitest run tests/rules/transition.rules.test.ts"
```

### R2 — The new client breaks

**No reliable CLI rollback.** `firebase hosting:rollback` does not exist in
this CLI version.

**Provider UI:** Firebase console → **Hosting** → **Release history** → the
release immediately **before** your Phase E deploy → **⋮** → **Rollback**.

*Confirming you picked the right one:* releases are listed with timestamp and
the deploying user. The correct target is the newest release *older* than your
Phase E hosting deploy. After rolling back, hard-reload the site and check the
bundle hash in DevTools → Network differs from the one you just shipped.

**Verify:** the site loads; a like works; `/rank` fallback warnings appear in
the browser console (expected — that is the old client on the new backend).

**Is rolling back safe once new like documents exist?** **Yes, while the
transitional rules are live.** The old client reads and writes `likedBy`,
which was never deleted, so it keeps working. Like documents created by the
new client are simply invisible to it.

The cost is a **split brain**: a like made on the new client lives only in the
subcollection; one made afterwards on the old client lives only in the array.
Both are preserved, neither is lost. Re-running `migrate_likes.py --apply`
after rolling forward reconciles the array side, and the watermark ensures it
does not resurrect anything removed in between.

**After Phase H, deploy transitional rules BEFORE rolling back the client** —
the old client cannot write `likedBy` under strict rules. Order: **R5**, then
**R2**.

### R3 — The API breaks

**Provider UI:** Railway → **web** service → **Deployments** → the deployment
immediately before your Phase E deploy → **⋮** → **Redeploy**.

*Confirming you picked the right one:* Railway lists each deployment with its
commit SHA. The correct target is the one whose SHA is **not** on
`fitfeed-production-hardening` — i.e. the last deploy from `main`.

**Verify:**

```bash
curl -s https://<api-host>/health                                   # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<api-host>/rank
# 200 = the OLD backend is back
```

**Safe?** Yes. The API is stateless.

### R4 — The worker misbehaves

**Provider UI:** Railway → **worker** service → **Settings** → **Remove**, or
scale to zero replicas.

**Verify:** Firestore → `analysisJobs` → jobs remain at `queued` and stop
transitioning. Nothing is lost; analysis is delayed.

**Safe?** Yes. Leases expire and jobs drain when it returns. Never urgent
enough to justify rushing another phase.

### R5 — Likes fail after the strict cutover

Someone is still on an old bundle.

```bash
cd fit-feed
npm run deploy:rules:transition
```

**Verify:** console → Rules → the active version contains
`FITFEED_TRANSITIONAL_RULES`; a legacy like succeeds again from an old client.

Wait longer, re-verify, then retry Phase H.

### R6 — A partially completed migration

`migrate_likes.py` is idempotent and additive: it only *creates* like
documents that are missing and realigns counts to the document count. An
interrupted run leaves a partially backfilled but entirely consistent state.

```bash
cd fit-feed/python-backend
python migrate_likes.py --apply     # resumes; skips what already exists
python migrate_likes.py --verify    # must be clean before continuing
```

**Verify:** `VERIFY OK`.

There is no "undo" and none is needed — the migration adds data, and the
legacy array it derives from is untouched. If you genuinely need to remove the
backfilled documents, they are exactly the ones in `likedByMigrated`, and the
Phase B backup is the reference.

### What must never be deleted during any rollback

| Never delete | Why |
| --- | --- |
| `likedBy` on post documents | The only record of a legacy like, and the whole rollback path for the old client |
| `likedByMigrated` | Without it, a migration rerun resurrects every intentionally removed like |
| `posts/*/likes/*` | The only record of likes made through the new client |
| `firestore.transition.rules` | The one-command fix for R1 and R5 |
| `userTasteState/*` | Monotonic; deleting makes a stale cached vector look fresh |
| `analysisJobs/*` | Carries the attempt budget; deleting re-arms paid work |
| The Phase B backup | Obviously |
| Firebase Hosting release history | R2 depends on it |

Safe to delete during rollback: **nothing**. Every route here is a redeploy or
a re-run.

---

## Like architecture reference

### Legacy schema (currently in production)

```
posts/{postId}
  likesCount: number          denormalised counter
  likedBy:    string[]        every liker's uid, unbounded
```

One write toggles both:
`{ likesCount: increment(±1), likedBy: arrayUnion/arrayRemove(uid) }`.

### New schema

```
posts/{postId}
  likesCount:       number    unchanged
  likedByMigrated:  string[]  migration watermark, server-owned, temporary

posts/{postId}/likes/{uid}
  uid:       string
  createdAt: string
```

### The questions that decide the rollout

| Question | Answer |
| --- | --- |
| Is `likedBy` migrated? | **Yes** — `migrate_likes.py --apply`. |
| Is it dual-read? | **No.** The subcollection is the only source of truth. A fallback would be permanently wrong: no client can write `likedBy`, so an unliked-after-migration post would show as liked forever. |
| Is it deleted? | **No.** Retained as the rollback path; retired in Phase I. |
| Source of truth for "did I like this?" | `posts/{postId}/likes/{uid}` exists. Backend `attach_liked_by_me`; client `hasLiked` / `getLikedPostIds`. |
| Source of truth for `likesCount` | The counter, kept honest by the rules. The like documents are the recount authority when they disagree. |
| Simultaneous likes | Independent documents, independent `increment()`. Both land. |
| Double-click | The transaction reads the like document first, so it toggles rather than stacking. |
| Offline / retry | A Firestore transaction; a retry re-reads and re-decides. Idempotent. |
| Can counts drift? | Narrowly — the rules permit deleting a like document without decrementing. `reconcile_likes.py` realigns. |
| Post deletion cleanup | Incomplete by design: Firestore does not cascade-delete subcollections and an author cannot delete others' likes. `reconcile_likes.py` sweeps orphans. |
| User deletion cleanup | Not implemented; no account-deletion flow exists. Tracked in transition-cleanup.md. |
| When can `isLegacyLikeToggle()` go? | See [transition-cleanup.md](transition-cleanup.md) — four conditions. |

### Reconciliation cadence

`reconcile_likes.py` is **run manually on a defined cadence**, not scheduled.

Automating it would need either a Railway cron service (another deployable,
another copy of the service-account credentials, for a job that writes to
every post) or a Cloud Function (a new deployment target this project does not
otherwise use). Both add standing infrastructure and a standing credential to
fix drift that, by construction, only arises from a console user or a
partially applied legacy write — neither of which happens on a schedule.

**The cadence:**

| When | Command | Expect |
| --- | --- | --- |
| Daily during Phase F | `python reconcile_likes.py` | `drifted=0`, `orphaned=0` |
| Phase G | `python reconcile_likes.py --apply` | Clean afterwards |
| Monthly thereafter | `python reconcile_likes.py` | `drifted=0`; apply if not |
| After any bulk post deletion | `python reconcile_likes.py --apply` | Orphans swept |

This is a checklist item in [transition-cleanup.md](transition-cleanup.md) so
it has an owner rather than living only here. Revisit automation if drift is
ever observed outside a migration window — that would mean a real source
exists and is worth instrumenting.

---

## Quick reference

```bash
npm run rehearse:migration                  # rehearse everything, emulators only

npm run backup:firestore -- --out ../backups/DATE-pre-migration
npm run backup:verify    -- ../backups/DATE-pre-migration

cd python-backend
python migrate_likes.py                     # dry run
python migrate_likes.py --apply
python migrate_likes.py --verify
python migrate_likes.py --apply --prune-stale   # Phase G: REQUIRED, not optional

python reconcile_likes.py                   # dry run: drift + orphans
python reconcile_likes.py --apply

cd ..
npm run deploy:rules:transition
npm run deploy:rules:strict
npm run rules:check                         # generated file still in sync?
npm run smoke:production -- --api https://<api-host> --site https://<site-host>
```
