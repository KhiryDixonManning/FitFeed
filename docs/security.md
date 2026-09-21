# Security

## Threat model

FitFeed is a public social app with user-generated images, a paid AI
dependency and a denormalized datastore. The adversaries worth designing
against:

| Adversary | What they want | Primary control |
| --- | --- | --- |
| A signed-in user with dev tools | Inflate their own counts, read others' private data, write to another user's subtree | Firestore/Storage rules, verified on the server side of the boundary |
| A signed-in user acting economically | Burn the Anthropic budget, or farm recommendation signal | Attempt budgets, rate limits, schema-level deduplication |
| An unauthenticated caller | Reach the API, enumerate users | Token verification on every route; no email in public profiles |
| Someone who can choose a URL | Make the server fetch an internal address (SSRF) | Host allowlist; the client never supplies a URL at all |
| A malicious image | Decompression bomb, resource exhaustion | Size, type and pixel-count limits before decode |

The client is never trusted for authorization, ranking inputs, identity, or
timestamps that affect scoring.

## Identity and authentication

- Every protected Flask route runs `require_auth`, which verifies a Firebase
  ID token with `firebase-admin`. The uid comes from the verified token and
  is placed on `g.uid`; a `uid` in a request body is rejected outright rather
  than ignored.
- When the Admin SDK has no credentials, verification is *unavailable* and
  routes answer 503 — they never fall through to unauthenticated handling.
- The Firebase Web API key in `fit-feed/firebase.ts` is a public client
  identifier, not a credential. It ships in every browser bundle by design
  and grants nothing on its own; authorization is the rules plus verified
  tokens. The hygiene scanner allowlists that single occurrence by exact path
  and shape, so an `AIza…` key anywhere else still fails the scan.

## Authorization (Firestore)

Rules are the boundary, and they are tested adversarially rather than
assumed. Highlights:

**Server-owned fields.** Analysis output (`palette`, `aesthetic`,
`aestheticScores`, `analyzed`, `analysisStatus`, …) has no client update
rule. A user can create a post with `analysisStatus: 'pending'` and nothing
more; everything else is written with the Admin SDK.

**Like invariants.** `likesCount` may only move by ±1, and only in a commit
where the caller's *own* like document at `posts/{id}/likes/{uid}` appears or
disappears. This is checked against post-commit state with `getAfter` /
`existsAfter`, so the counter and the documents cannot diverge. The document
id is the uid, which makes "one like per user per post" a property of the
schema rather than something to enforce. The legacy `likedBy` array is no
longer writable by any client.

**Comment invariants.** `commentsCount` may only move by +1 alongside a
`lastCommentId` naming a comment that exists after the commit. An earlier
version allowed a free ±1 step; a mutation test against the old rule fails in
10 places.

**Composite ids.** `saves/{uid}_{postId}` and `follows/{a}_{b}` encode their
participants in the id, so the id cannot claim a relationship the payload
denies.

**Profile split.** `users/{uid}` holds the private profile including email
and is owner-only. `publicProfiles/{uid}` holds handle and avatar and is
world-readable. Public reads previously exposed email, which made the
follower list a user-enumeration primitive.

### Interaction signals

`users/{uid}/interactions/{type}_{postId}` — owner-only for read *and* write.
The audited invariants, each with tests in
`tests/rules/interaction.invariants.test.ts`:

| Invariant | Mechanism |
| --- | --- |
| The id is exactly `type + '_' + postId` | Rule compares the path segment to the payload |
| `type` is from a closed enum | `in ['impression','view','more_like_this','not_interested']` |
| `postId` and `type` are immutable | The id is fixed by the path, so any change breaks the equality |
| No extra fields | `hasOnly([...])` — no userAgent, ip, session, referrer, weight or duration |
| Dwell is a coarse bucket | `value in ['short','meaningful','long']`, never a duration |
| The post must exist | `exists(/posts/$(postId))`, so ids cannot be invented to grow storage |
| No cross-user writes or reads | `userId == uid()` on every operation |

Dwell being three buckets is a privacy property: the stored value cannot
reconstruct how long somebody actually looked at something.

### Taste-state marker

`userTasteState/{uid}` is a monotonic counter. The rules require a strictly
increasing integer, a step of at most 10, owner-only access, and refuse
deletion. Lowering or deleting it would make an already-stale cached taste
vector look fresh — a way to pin your profile to an old state.

Every taste-relevant mutation stages its bump inside the *same* batch or
transaction as the mutation, so a rejected like cannot leave a moved marker
behind, and a future refactor cannot drop the invalidation without also
dropping the write.

### Analysis jobs

`analysisJobs/{jobId}`: readable by the author of the corresponding post,
`allow write: if false`. Only the Admin SDK touches them.

## Authorization (Storage)

Uploads are restricted to the caller's own path, with content-type and size
limits enforced in the rules — not only in the client, which can be bypassed.
An `/avatars` rule was added after avatar uploads were found to be silently
denied.

## SSRF and image ingestion

The `/analyze` endpoint takes a **post id, never a URL**. The image URL is
read from Firestore server-side, so there is no client-controlled fetch
target at all. Beyond that, `image_fetch.py`:

- **Host allowlist.** Only the configured Firebase Storage bucket hosts.
- **No redirects.** `allow_redirects=False` — a 302 could otherwise walk
  straight off the allowlist to `169.254.169.254`.
- **Declared-length check, then a streamed cap.** `Content-Length` is checked
  when present and the body is read through a hard 10 MB ceiling regardless,
  so a lying or absent header does not help.
- **Content verification.** The bytes are verified to be a real image of an
  accepted type, not trusted from the `Content-Type` header.
- **Pixel-count limit.** 40 MP, set on Pillow before decode, so a small
  highly-compressed file cannot expand into gigabytes of bitmap.

## Rate limiting

Per-verified-uid sliding windows, applied after authentication so an
unauthenticated caller cannot consume anyone's quota:

| Route | Burst | Sustained |
| --- | --- | --- |
| `/analyze` | 5 / min | 30 / hour |
| `/feed`, `/trending`, `/interactions` | 60 / min | 600 / hour |
| `/reanalyze-all` | 10 / min, keyed by peer address | — |

Bookkeeping is bounded: idle keys are evicted so a long-lived worker cannot
grow without limit.

## Paid-work controls

The Anthropic call is the most expensive thing in the system, and several
layers exist to make sure it happens exactly once per post:

- **Atomic claim.** `claim_post_for_analysis` is a transactional
  compare-and-set on `analysisStatus`, so two concurrent requests cannot both
  proceed. Contention is classified and retried rather than surfacing as a
  500 — including the case where the SDK wraps an exhausted `Aborted` in a
  `ValueError`.
- **Idempotent enqueue.** The post id is the job id.
- **Attempt budget.** Three attempts per post, preserved across re-enqueue.
  Exhausted posts are not re-armed by any user action; the UI says so instead
  of offering a retry.
- **Worker leases.** A 10-minute lease means a crashed or redeployed worker's
  job is reclaimed once, not processed twice.
- **Failure classification.** Permanent failures (post deleted, image
  unusable, owner mismatch) fail immediately rather than burning the budget;
  transient ones retry with exponential backoff and jitter.
- **Bulk reanalysis is opt-in.** `/reanalyze-all` is a dry run unless the
  request body contains the boolean `{"apply": true}` — a truthy string does
  not count — it enqueues rather than calling the model inline, and it caps
  its scan at 500 posts.
- **No paid call in tests.** `tests/conftest.py` pops `ANTHROPIC_API_KEY`
  from the environment at import time, before anything can capture it into a
  module-level client. Tests that exercise the analysis path substitute their
  own function, and CI asserts the conftest line still exists.

## Secret handling

- Secrets come from environment variables. `.env` and
  `serviceAccountKey.json` are gitignored and CI fails if either becomes
  tracked.
- `.env.example` documents every variable **by name with empty values**.
- The hygiene scan (`npm run check:secrets`, and the `hygiene` CI job) greps
  tracked content for provider-specific key shapes. It is deliberately narrow:
  a scanner that cries wolf is a scanner someone disables.
- No secret is logged. Error responses are sanitized — internal exception
  text never reaches the client, which is covered by a test that plants a
  fake credential path in an exception and asserts it does not appear in the
  response.

## Dependency audit

| Scope | Result |
| --- | --- |
| npm, production (`npm audit --omit=dev`) | **0 vulnerabilities** |
| npm, including dev | 10 advisories, all in `firebase-tools` and `vitest` |
| Python (`pip-audit`) | **0 vulnerabilities** after patching |

The remaining npm advisories are dev-only and the fix npm offers is a
**downgrade of `firebase-tools` from 14.x to 10.1.1** — four major versions
back — which would break the emulator workflow the entire test suite depends
on. Neither package ships to users or runs in production. Taking the
downgrade would trade a real capability for a theoretical local risk, so it
is declined and recorded here instead.

`pip-audit` cannot run on the current development machine: a TLS-intercepting
corporate proxy makes Python unable to verify `pypi.org` (the substituted CA
chain lacks an Authority Key Identifier, which Python rejects and Node does
not). It runs in CI, where egress is clean — and its first run there earned
its place, reporting **24 advisories across three production packages** that
were invisible locally:

| Package | Was | Now | Advisories cleared |
| --- | --- | --- | --- |
| Flask | 3.0.0 | 3.1.3 | PYSEC-2026-2151 |
| Werkzeug | 3.0.1 | 3.1.6 | PYSEC-2026-1860, -2043, -2044, -2045, -2046, -2320, -3417 |
| flask-cors | 4.0.0 | 6.0.0 | PYSEC-2024-71, -271, PYSEC-2026-1383, -1384, -1385 |

flask-cors crosses a major version deliberately. Three of its advisories have
no fix below 6.0.0, and leaving known CVEs in the CORS layer of a production
dependency is not a trade worth making to avoid a major bump. The call site
uses only `origins`, `allow_headers`, `methods` and `max_age`, which are
unchanged in 6.x; allowed and disallowed origins were both re-checked against
a running server after the upgrade.

## Accepted limitations

These are known and deliberate, not oversights:

- **Rate limits are per worker process, in memory.** With two Gunicorn
  workers the effective limit is roughly double the configured one, and a
  restart clears the window. It bounds accidental hammering and casual abuse,
  not a distributed attacker. A shared store (Redis) would fix it; that
  dependency is not justified at this scale.
- **`ADMIN_API_KEY` is a shared static secret** sent in a header. There is no
  rotation, no per-operator identity and no audit trail of who ran what. The
  mitigations are that the route 404s when the variable is unset, is rate
  limited by peer address, and now only ever *enqueues* work. Real admin
  auth (a Firebase custom claim, or an IAM-fronted internal endpoint) is the
  correct fix.
- **Migration debt: `likedBy` still exists** on pre-migration post documents.
  It is no longer written or read, but the data is retained as the rollback
  path until `migrate_likes.py --verify` reports clean. Dropping it is a
  separate change. Until the migration runs, the current client would show a
  pre-migration like as "not liked" — which is why the migration must precede
  the deploy. See [deployment.md](deployment.md).
- **No App Check.** Nothing proves requests come from the real app, so the
  API and Firestore are reachable by any authenticated client. The rules
  assume this and are written to be safe under it.
- **The `exists()` check on interaction writes costs a document read per
  signal**, which is the highest-volume write path. It is worth it — without
  it a user can mint unlimited documents in their own subtree — but it is a
  real cost, not free.
- **No abuse reporting or moderation** for image content.
