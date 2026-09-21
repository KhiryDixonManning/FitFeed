# Deployment

> **The proposed 8-step order is nearly right, but it has one gap.** Steps
> 1–4 are correct as written. Step 5 (rules) cannot be deployed against the
> currently live client without breaking likes, because the old and new
> clients need *mutually exclusive* rule sets. The corrected sequence below
> splits the rules deploy in two. The analysis is in
> [Compatibility](#compatibility-what-actually-breaks).

## Environment variables

By name only. Never commit values; `.env.example` documents each with an
empty value.

**Both Railway services (`web` and `worker`):**

| Name | Required | Notes |
| --- | --- | --- |
| `GOOGLE_CREDENTIALS_JSON` | yes | Service account JSON, single line |
| `ANTHROPIC_API_KEY` | worker only, in practice | The web process no longer calls the model |
| `FIREBASE_STORAGE_BUCKET` | no | Defaults to the project bucket |
| `ADMIN_API_KEY` | no | Unset ⇒ `/reanalyze-all` returns 404 |
| `LOG_LEVEL` | no | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `PORT` | web only | Supplied by Railway |

**Worker only:**

| Name | Required | Notes |
| --- | --- | --- |
| `WORKER_POLL_SECONDS` | no | Poll interval when the queue is empty |
| `WORKER_BATCH_SIZE` | no | Jobs leased per pass; each is a paid call |

## The safe sequence

Run `npm run verify` and both Playwright projects first. Do not start if
anything is red.

### 1. Dry-run the like migration

```bash
cd fit-feed/python-backend
python migrate_likes.py
```

Reports how many like documents *would* be created and flags any post whose
`likesCount` disagrees with its distinct liker count. Writes nothing.

### 2. Apply it

```bash
python migrate_likes.py --apply
```

Creates `posts/{id}/likes/{uid}` for every entry in every `likedBy` array and
reconciles `likesCount`. Idempotent — a second run changes nothing. **It does
not delete `likedBy`**; that stays as the rollback path.

### 3. Verify it

```bash
python migrate_likes.py --verify
```

Asserts that, for every post, the number of like documents equals
`likesCount`. **Do not continue until this reports clean.**

Why this must come first: no client falls back to the legacy array. The rules
do not let a client write `likedBy`, so a client cannot remove itself from
one. A like that exists *only* in the array would read as "not liked", and
pressing the heart would create a like document on top of the array entry —
counting the same person twice. Backfilling first makes that impossible.

### 4. Deploy Firestore indexes, and wait for them

```bash
firebase deploy --only firestore:indexes
```

Then **wait until every index reports Enabled** in the Firebase console.
Index builds are asynchronous; a query issued against a building index fails
with `FAILED_PRECONDITION`. The new backend depends on the collection-group
`likes` index and both `analysisJobs` indexes, so deploying it early turns
the feed and the worker into error loops.

### 5. Deploy *transitional* rules

This is the step the original ordering is missing. Publish a rules version
that permits **both** the legacy array write and the new subcollection write,
so old and new clients both work while browsers still hold old JavaScript.
Take the current `firestore.rules` and, for the transition only, re-admit the
legacy like update alongside the new one.

```bash
firebase deploy --only firestore:rules
```

Everything else in the current rules — the interaction invariants, the
monotonic taste marker, the analysis-job lockdown, the profile split — is
safe to ship here, because no currently deployed client writes any of it.

### 6. Deploy the Railway worker

Worker before web: the worker on an empty queue is a no-op, whereas web
before worker leaves new uploads sitting at "Queued" with nothing draining
them.

### 7. Deploy the Railway web service

### 8. Deploy the frontend

```bash
cd fit-feed && npm run build && firebase deploy --only hosting
```

### 9. Tighten the rules

Once old clients have drained — open tabs keep running old JavaScript until
they reload, so allow a real window, not minutes — deploy the strict
`firestore.rules` from this repository, which refuses `likedBy` writes
entirely.

### 10. Later, and separately: drop `likedBy`

Only after a clean `--verify` and a period with no client reading it. This is
its own change with its own rollback, never bundled with a feature release.

## Compatibility: what actually breaks

The frontend and backend in this repository are **not wire-compatible in
either direction** with the currently deployed pair. This is a coordinated
release, not a rolling one.

| Combination | Result |
| --- | --- |
| Old client + old backend | Works (current production) |
| Old client + **strict** new rules | **Likes fail.** The old client writes `likedBy: arrayUnion(...)`, which the strict rules refuse |
| New client + old rules | **Likes fail.** No rule matches `posts/{id}/likes/{uid}`, so the write is denied by default |
| Old client + new backend | **Feed fails** if that build calls `/rank`, which was removed in favour of `/feed` |
| New client + old backend | **Feed fails.** `/feed`, `/interactions` do not exist on the old backend |
| New client + new backend + strict rules | Works |

Two consequences:

- **The transitional rules step (5) is what makes the like path survive the
  window.** Without it there is an outage lasting as long as users keep old
  tabs open.
- **Steps 7 and 8 should be close together.** There is no rule trick that
  makes the old client talk to the new API; whichever side deploys first,
  the feed is degraded until the other lands. Keep the gap to minutes and
  prefer a low-traffic window.

Before deploying, confirm what the live bundle actually calls — the build
currently on Hosting predates this work and was not inspected while writing
this document.

## Verifying a deploy

Do not report a deploy as complete without checking:

```bash
curl -s https://<api-host>/health                      # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' \
     -X POST https://<api-host>/feed                   # 401, not 200 or 500
```

- Hosting: hard-reload the live site and confirm the bundle hash changed.
- Worker: upload a post and watch it move Queued → Analyzing → analysed. If
  it sticks at Queued, the worker service is not running or lacks
  credentials.
- Rules: the rule tests run against the emulator, not production. After
  deploying, spot-check one denial by hand.

## Rollback

| What went wrong | Action |
| --- | --- |
| Frontend regression | Firebase Hosting keeps previous releases — roll back in the console; it is instant and needs no rebuild |
| API regression | Redeploy the previous Railway deployment. The API is stateless |
| Worker regression | Stop the worker service. Jobs stay queued and drain when it returns — nothing is lost, analysis is just delayed |
| Rules regression | Redeploy the previous rules version. Keep the transitional version to hand: reverting to strict-minus-one is the quickest way to unbreak writes |
| Migration concern | Nothing to roll back. The migration only *adds* like documents and reconciles counts; `likedBy` is untouched, so the old client's read path still works |

The migration is the only irreversible-ish step, and it was designed not to
be: it never deletes, so the worst case is extra documents nothing reads.

**Do not roll back an index deploy** while code that needs the index is
live — drop the code first.

## What is not automated

CI builds, tests and audits. It does **not** deploy. Every step above is run
deliberately by a human, because the ordering constraints here are not
expressible as a pipeline: they depend on how long real users keep stale tabs
open, and on a migration whose verification a person should read.
