# FitFeed Improvement Plan — persistent session context

> Read this first each session. Don't re-derive anything recorded here.
> Last updated: 2026-08-27. Phase 1, 1B, Phase 3 (saved outfits), Phase 3b
> (why-recommended), and Phase A of the polish mission (empty/loading
> states) are COMPLETE. Phase A changes are built + tested locally but NOT
> committed and NOT deployed — this machine currently has no deploy
> credentials (see Phase A → Environment). Phases B (performance) and C
> (competitive proposals) not started.

## Phase 1 / 1B — VERIFIED FIXED (2026-08-22, second pass)
- User fixed Firebase billing. Re-ran `diagnose_posts.py`: all sampled images
  now return **HTTP 206** (was 402). Confirmed live via Playwright screenshot
  of the deployed feed — real photos render, `naturalWidth` check found
  **0 broken images** across desktop + mobile viewports.
- Deployed the Phase 1 code fixes (`npm run build` + `firebase deploy --only
  hosting`, approved by user). Live site now runs the try/catch-hardened
  Profile/PublicProfile + PostImage fallback component.
- Profile page verified on production with a throwaway diagnostic account
  (created via `firebase-admin`, used for verification, then deleted after
  Phase 2 — see below): loads cleanly, never sticks on the spinner.
- Railway `/rank` and `/trending` still 404/CORS-fail in the browser console
  (matches Phase 1B finding below) — frontend fallback behaves correctly,
  banner shown intermittently depending on fetch timing. Left untouched per
  user instruction; Railway is being handled outside this session.
- **The source changes are still uncommitted in git** (only deployed via
  `dist/`). Commit when the user asks — not done automatically.

## Phase 1 — Image + Profile bugs

### Root cause: broken post images (CONFIRMED with runtime evidence)
**Billing is NOT actually fixed.** On 2026-08-22, every sampled post `imageUrl`
(6 posts spanning oldest 2026-04-13 → newest 2026-05-20) returned:

```
HTTP 402 — "The billing account for the owning project is disabled in state closed"
```

- Firestore post docs are healthy: all 49 posts have well-formed
  `https://firebasestorage.googleapis.com/v0/b/fitfeed-67ee8.firebasestorage.app/o/posts%2F...`
  URLs (no schema drift between old and new posts; no empty/undefined values).
- The Storage bucket still exists (unauthenticated probe → 403 permission-denied,
  not 404), and objects are presumably intact — Google blocks the download
  endpoint with 402 while the linked billing account is in state "closed".
- **This is infrastructure, not code.** Someone must open Firebase console →
  Project settings → Usage and billing (or GCP console → Billing) for project
  `fitfeed-67ee8` and link an ACTIVE billing account. The previously linked one
  is closed. No code change can make images load until then.
- Firebase Auth and Firestore still work (feed loads data; login errors return
  normally), so only Storage delivery is blocked.

Verification tooling added (read-only, keep for future sessions):
- `fit-feed/python-backend/diagnose_posts.py` — samples newest/oldest posts,
  checks each imageUrl over HTTP (tokens redacted), checks users docs.
- `fit-feed/python-backend/diagnose_rules.py` — fetches the *deployed*
  Firestore/Storage rules via the Rules API for comparison with local files.
Both use `python-backend/serviceAccountKey.json` via the backend venv:
`python-backend/venv/Scripts/python.exe python-backend/diagnose_posts.py`.

### Root cause: Profile stuck on "Loading profile..."
Code defect confirmed by inspection (runtime repro blocked — see "Blocked" below):
`Profile.tsx`'s `load()` had **no try/catch/finally**. Every helper it calls
(getPosts, getUserPreferences, follower counts) swallows its own errors, but the
`getDoc(doc(db, 'users', uid))` at the end was unguarded — any rejection
(transient network failure, quota/billing degradation) leaves `loading=true`
forever with no error surfaced. Ruled out via evidence:
- Missing user doc: NO — users docs exist for all sampled authors.
- Stale deployed rules: NO — deployed rules (fetched via Rules API, released
  2026-04-16) are byte-identical to local `firestore.rules`.
- Stale deployed bundle: NO — deployed `index-Cx-FWSJt.js` matches local
  `dist/` built 1 minute after the final Apr 15 commit; contains current
  Profile markers.

### Repairs implemented (2026-08-22, in working tree, NOT yet committed/deployed)
1. **New `src/components/PostImage.tsx`** — shared image component; on missing
   src or load error renders a styled "Image unavailable" placeholder instead
   of the browser broken-image icon. Wired into: PostCard, Explore grid,
   Profile grid, PublicProfile grid, PostDetail main image, Leaderboard
   thumbnail, Insights thumbnail. (Avatars untouched — all photoURLs are
   currently unset and already have an emoji fallback.)
2. **`Profile.tsx`** — `load()` wrapped in try/catch/finally; new error state
   with a Retry button; spinner can never stick.
3. **`PublicProfile.tsx`** — same try/catch/finally hardening; also resolves
   loading when route uid is absent.

Verified: `npm run build` (tsc + vite) passes; all 3 existing Playwright auth
tests pass. Regression tests for the fixes were NOT added: there is no unit
test runner (Playwright only) and every affected page sits behind Firebase
auth, so a focused test needs either a test login or a vitest setup (new
dependency — out of scope per instructions).

### Blocked / needs the user
- **Fix billing** (images): link an active billing account to `fitfeed-67ee8`.
- **Deploy**: `firebase deploy --only hosting` after `npm run build` (and the
  fixes committed). Not done — deploys require explicit approval.
- **Runtime verification**: Playwright login to the deployed site needs test
  credentials the repo doesn't contain; creating a diagnostic account was
  blocked by the permission system. Provide a throwaway test login (or
  approve creating one) to complete the "screenshot of working feed" check.

## Phase 1B — Ranking server status (CONFIRMED, infrastructure)
`https://fitfeed-api-production.up.railway.app/health` → HTTP 404
`{"status":"error","code":404,"message":"Application not found"}` with
`x-railway-fallback: true` — the Railway **service/deployment no longer exists**
at that domain (deleted or expired free tier/credits), it is not merely
hibernating. Outside code-level fixes; needs the Railway dashboard (redeploy
`python-backend/` or point `src/config.ts` at a new host). The frontend's
yellow fallback banner is working as designed and was left untouched.
Note: `src/config.ts` also pings `/health` every 4 min in production — harmless
now, but pointless until the API is redeployed.

## Phase 2 — Product audit (COMPLETE, 2026-08-22)
Inspected the deployed site (desktop 1280px + iPhone 13 viewport) via
Playwright with the throwaway diagnostic account, plus source review of
StyleProfile.tsx, Insights.tsx, recommendation_engine.py.

### What already works and should be preserved
- **Feed cards are genuinely editorial**, not generic-SaaS: italicized AI
  outfit names in quotes ("Autumn Reverie in Crochet"), a color palette strip
  with hex + %, "Aesthetic Composition" percentage chips, clickable
  tag/color/category chips that route into Explore. This is the strongest,
  most on-brand part of the app already.
- **Aura score badge (◎ count)** — a distinct branded metric (likes+comments)
  instead of a generic like counter; good identity touch.
- **Leaderboard ("Aura Farmers")** — playful branded name, renders well,
  images + stats display correctly.
- **Style Profile radar chart** (StyleProfile.tsx) and **Creator Insights**
  (Insights.tsx: stat tiles, top posts, engagement-by-category bar chart) are
  already implemented with recharts and reasonably polished — not blank
  scaffolding. Two of the mission's candidate items are already substantially
  done; further investment there has lower marginal value than gaps below.
- **"Shop similar" store suggestions** in PostDetail (by aesthetic) already
  gives a lightweight version of "outfit similarity."
- Explore's tag/color/category deep-linking is a solid discovery mechanism
  already in place.

### Real gaps (evaluated against the candidate list)
1. **No saved outfits/collections at all.** No bookmark/save action exists
   anywhere in FirebaseDB.ts or any page. Explicit candidate-list item, fully
   missing, and independent of the (currently dead) Railway service — safe to
   build and fully testable right now.
2. **"Why this was recommended" / richer recommendation explanations —
   completely unsurfaced despite rich backend logic.** `recommendation_engine.py`
   already computes Wilson-score confidence, velocity/trending, comment:like
   ratio boost, freshness tiers, user-preference match, and a diversity
   penalty per post — genuinely interesting, legible signals — but none of it
   reaches the frontend; `/rank` returns only a reordered post array. High
   conceptual value, but **currently undemonstrable in production**: Railway
   is down (Phase 1B), so `/rank` never runs and the feed silently falls back
   to unranked order. Shortlisted for a future session once Railway is back.
3. **Empty/loading states undercut the "premium editorial" identity.**
   "Loading profile...", "Loading leaderboard...", "No posts yet. Upload your
   first fit!", "Upload posts to start seeing your insights." are flat gray
   text with no illustration or visual treatment — a jarring drop from the
   photography-forward feed. Style Profile's empty state is a literal
   grayed-out placeholder box. Cheap, frontend-only, no backend dependency.
4. **Zero onboarding.** Login.tsx is bare email/password with no explanation
   of what FitFeed does, no first-run guidance. Not in the explicit candidate
   list wording but matches "better onboarding."
5. Minor: PostDetail's analysis fields (aesthetic, palette, composition
   chips) only render for posts with populated `analyzed`/`palette` data —
   some older posts have sparse analysis data, so PostDetail looks bare for
   those specific posts. This is a data-completeness artifact (some early
   posts predate full analysis fields), not a rendering bug — confirmed by
   comparing against posts with full data, which render identically to
   PostCard's rich section.

### Shortlist for Phase 3 (highest quality-gain-per-cost, 3 of the 2-4 range)
1. **Saved outfits/collections** — SELECTED FOR PHASE 3. Self-contained
   (new Firestore collection + save button + a saved-items view), high
   product value, zero dependency on the down Railway service, fully
   testable now.
2. Redesigned empty/loading states matching the editorial visual identity —
   cheap follow-up, no backend dependency. Good candidate for a fast
   next-session win if Phase 3 leaves budget.
3. "Why this was recommended" surfaced from existing ranking-engine signals —
   most conceptually interesting, but blocked on Railway being redeployed
   (outside this session's access) before it can be verified end-to-end in
   production. Revisit once Railway status changes.

## Phase 3 — Implementation: Saved outfits/collections (COMPLETE, 2026-08-22)

### What was built
- **Data model**: new `saves/{uid}_{postId}` Firestore collection — mirrors
  the existing `follows/{followerId}_{followingId}` ownership pattern.
  Fields: `uid`, `postId`, `createdAt`. Private by design (no `savedBy` array
  on posts, unlike `likedBy` — saves aren't a public signal).
- **`FirebaseDB.ts`**: `savePost`, `unsavePost`, `isPostSaved`,
  `getSavedPostIds` — same try/catch shape as the existing follow helpers.
- **`firestore.rules`**: new `saves/{saveId}` match block — read/create/delete
  all gated on `request.auth.uid == (resource|request.resource).data.uid`.
  Purely additive, doesn't touch any existing rule; not a weakening.
- **Bookmark toggle UI**: new outline/filled bookmark icon button (same
  interaction pattern as the existing like button) added to `PostCard.tsx`
  (feed) and `PostDetail.tsx`. Not added to Explore/Leaderboard/Insights
  thumbnails — scoped to the two places where per-post actions already live.
- **`Feed.tsx`**: fetches `getSavedPostIds` once on mount into a `Set`,
  optimistic toggle handler mirroring the existing like-handling pattern.
- **`Profile.tsx`**: new "My Posts" / "Saved" tab switcher above the grid
  (Instagram-style), reusing the existing grid markup and `PostImage`
  fallback component. Saved tab has its own empty state and an unsave
  action on each tile.

### Deploy
`firebase deploy --only firestore:rules,hosting` — needed one retry (see
below); succeeded on retry, live at https://fitfeed-67ee8.web.app.

### End-to-end verification (production, throwaway diagnostic account,
created and deleted within this session)
All 4 checks passed via Playwright against the live site:
1. Saving from the Feed (PostCard) toggles the bookmark to filled state.
2. The saved post appears in Profile → Saved, confirmed to be the same post
   (image src compared).
3. Unsaving from the Saved tab removes it (count drops to 0).
4. Saving from PostDetail **persists across a full page reload** — proves a
   real Firestore write, not just client-side state — with **zero
   permission-denied console errors**, confirming the new rules deployed
   correctly.
Visually confirmed via screenshot: filled purple bookmark icon on the feed
card, and the saved post's photo + outfit name + category correctly
rendered in the Saved tab.

### Known friction this session (for future reference)
`firebase deploy` (even hosting-only, previously approved and working
earlier in this same session) was blocked twice by the permission
classifier before a user-approved retry succeeded. Cause unclear — possibly
tied to the mid-session `/model` switch. No workaround was needed once the
user re-approved; flagging in case it recurs.

### Not done / explicitly deferred
- The empty-states redesign remains deferred (not requested this pass).
- No collections/multiple saved lists — this is a single flat "Saved" list,
  matching the scoped MVP described in the shortlist. Multi-collection
  support (e.g. named boards) would be a natural follow-up if requested.

## Phase 3b — "Why this was recommended" (COMPLETE and VERIFIED, 2026-08-23)

### Railway re-verification (done first, as requested)
User redeployed Railway. Confirmed directly:
- `GET /health` → `{"status":"ok"}` (verified via curl and in-browser)
- CORS reflects `https://fitfeed-67ee8.web.app` correctly on both `/health`
  and the `/rank` preflight (`OPTIONS` with `Access-Control-Request-Method:
  POST`) — no CORS bug, matches the existing explicit-origin allowlist in
  `app.py`.
- Live Playwright check on production with a throwaway account: offline
  banner **not shown**, `GET /health` → 200 and `POST /rank` → 200 in the
  network log, zero console errors. Railway is fully healthy from the
  frontend's perspective.

### What was built
`recommendation_engine.py` already computed several legible per-post
signals (Wilson-score engagement confidence, trending velocity, comment
ratio boost, freshness tier, user-preference match) but only ever returned
a reordered post list — none of it reached the user. Changed `calculate_score`
to return `(score, factors)` where `factors` is a small dict of weighted
contributions (`communityConfidence`, `trendingVelocity`, `conversationBoost`,
`styleMatch`) plus `freshnessTier`/`ageHours`/`matchedCategory`; threaded
through `apply_diversity_penalty`; `rank_posts` now attaches `_rankingFactors`
to each returned post. Verified locally with a standalone script (3 synthetic
posts, checked the returned breakdown makes sense — the fresh/preference-
matched post scored highest with `styleMatch` and `freshnessTier` as the
visible drivers).

Frontend: new `src/utils/rankingExplanation.ts` turns the raw contribution
weights into 1-3 short, human-readable reasons ("Trending right now",
"Matches your streetwear style", "Just posted"), sorted by strength and
filtered below a noise threshold (avoids showing a "reason" for a
near-zero contribution). `Post` interface gets an optional `_rankingFactors`
field. `PostCard.tsx` gets a small "Why this?" toggle in the actions row —
present only when ranking data exists — that reveals the reasons as chips
matching the existing Aesthetic Composition chip style (no new visual
language, no dashboard/badge look, consistent with the Phase 2 audit's
identity guidance). Wired into `Feed.tsx` **only for the For You tab**
(`rankingFactors={tab === 'foryou' ? post._rankingFactors : undefined}`) —
Discover is chronological and Following is social, so a ranking
explanation wouldn't be meaningful there. Degrades safely: any post without
`_rankingFactors` (unranked fallback, or Discover/Following) simply has no
"Why this?" button — no broken state possible.

Build passes (`npm run build`). Committed:
`36eadc4 Surface why each post was ranked into the feed` (rebased onto a
README commit made directly on GitHub since the last push — no conflicts).

### Railway deploy — resolved
The GitHub push alone did not trigger a Railway redeploy (confirmed stale
code for several minutes after pushing, and my Railway CLI session stayed
unauthenticated throughout — expired token, `railway login`/`railway ssh`
both rejected with `invalid_grant`, so I could not SSH in or inspect the
dashboard config myself). Root cause, per the user: **Root Directory
wasn't set to `python-backend`** in the Railway service's Source settings
(this is a monorepo, and Railway needs to be told the backend lives in a
subfolder, not the repo root). User set Root Directory correctly and
triggered a manual deploy from the dashboard. Verified directly against the
live endpoint (`curl -X POST .../rank`): `_rankingFactors` now appears with
sensible values (e.g. a post matching a test user's `streetwear` preference
showed `styleMatch: 0.16`, `communityConfidence`, `trendingVelocity`,
`freshnessTier` all populated).

### Frontend deploy + full Playwright verification (production, throwaway
account created and deleted within this session)
Built and deployed (`firebase deploy --only hosting`) twice: once with the
feature, and once more after adding `data-testid="why-this-button"` /
`data-testid="why-reasons"` to PostCard — the reveal chips reuse the same
Tailwind classes as the pre-existing Aesthetic Composition chips, so a
class-based Playwright selector was matching across every card on the page
instead of just the clicked one; test ids fixed that. All checks passed
precisely scoped:
- In-browser `fetch` to `/rank` confirmed `_rankingFactors` present in the
  actual response the app receives (not just via curl).
- **For You tab**: all 49 posts rendered a "Why this?" button (ranking
  succeeded for the whole feed). Clicked 3 buttons independently; each
  revealed exactly the expected reason — "Loved by the community" — scoped
  correctly to its own card with zero cross-contamination. (This diagnostic
  account had no interaction history, so `styleMatch` was 0 for every post
  as expected — only `communityConfidence`, the highest-weighted signal,
  cleared the display threshold. Expected behavior, not a bug.)
- **Discover tab**: 0 "Why this?" buttons — correctly absent (chronological
  order, not ranked).
- **Following tab**: 0 "Why this?" buttons — correctly absent (social order,
  not ranked).
- Zero console errors throughout.
Visually confirmed via screenshot: the toggle sits inline with
like/comment/save, matches the app's icon-button style, and the reveal chip
matches the existing chip visual language (colored dot + pill) — no new
"dashboard" component introduced, consistent with the Phase 2 audit's
identity guidance.

Commits: `36eadc4` (feature), `52cf5a2` (test ids) — both pushed to
`origin/main`.

## Phase A — Empty/loading states + UI seams (COMPLETE locally, 2026-08-27)

Part of the "polish, performance & competitive audit" mission
(docs/fitfeed-prompt-optimized.md). Phases: A (UI/UX) done; B (perf) and
C (competitive proposals) pending.

### Environment changes since 2026-08-23 (important for future sessions)
- **Node.js is gone from this machine** (no node/npm anywhere on PATH or
  disk), `fit-feed/node_modules` was gone, and
  `python-backend/serviceAccountKey.json` + `python-backend/venv` are gone.
  Firebase CLI and its cached credentials are gone too. Previous sessions
  had all of these — the machine was evidently cleaned.
- Workaround used this session: portable Node v22.14.0 unzipped into the
  session scratchpad (not installed system-wide), `npm ci` restored
  node_modules. Corporate TLS-inspecting proxy requires
  `NODE_EXTRA_CA_CERTS=<exported Windows root CAs .pem>` for npm and
  `curl --ssl-no-revoke` for downloads.
- **Consequence: could NOT deploy or verify on production** (no Firebase
  credentials, no admin key for a throwaway account). All Phase A
  verification is local. Deploy + production check still owed once
  credentials exist again.
- Also: `docs/fitfeed-improvement-plan.md` was deleted from the working
  tree sometime before/during this session (not by the session); restored
  via `git restore`.

### What was built (all frontend, no behavior/schema changes)
Two new shared components:
- `src/components/EmptyState.tsx` — editorial empty state: three muted
  swatch dots (echoes the palette-chip identity), tight title, one
  supporting line, optional outlined pill action. `compact` variant for
  in-card placements.
- `src/components/Skeletons.tsx` — PostCardSkeleton, GridTileSkeleton,
  LeaderboardRowSkeleton, ProfileHeaderSkeleton, InsightsSkeleton. All
  mirror their real layouts (same aspect ratios/padding) so content lands
  with zero layout shift; same visual language as PostDetail's existing
  skeleton (var(--border) blocks + animate-pulse).

Wired in:
- **Feed**: loading → 4 PostCardSkeletons in the real grid. Empty states
  split into 4 contextual variants: no follows (→ Browse Discover), no
  posts at all (→ Upload a fit), category empty (→ Show all styles),
  follows-but-quiet (→ Browse Discover).
- **Explore**: header now persists during load (was a full-screen pulse
  that dropped the whole header — big layout shift); skeleton tile grid;
  post count hidden while loading; title normalized text-xl → text-2xl to
  match every other page; empty state distinguishes filtered vs unfiltered.
- **Profile**: full skeleton page (header + style-profile block + grid);
  My Posts empty → EmptyState + Upload CTA; Saved empty → EmptyState
  ("private moodboard" framing) + Find-fits CTA.
- **PublicProfile**: skeleton header + grid; empty → EmptyState.
- **Insights**: loading keeps the page shell (title + handle) with
  InsightsSkeleton; zero-posts empty → EmptyState + Upload CTA.
- **Leaderboard**: heading + filter-pill skeletons + 5 row skeletons;
  empty → EmptyState (category-aware, with Show-all action).
- **PostDetail**: "Post not found" → EmptyState with back-to-feed action
  (loading skeleton already existed, untouched).
- **StyleProfile**: empty state redesigned as a "ghost portrait" (4 muted
  category rows waiting to fill) + invitation copy. **Also fixed a real
  rules-of-hooks bug**: the four useMemos were called AFTER the empty-state
  early return, so preferences transitioning empty → populated would throw
  "Rendered more hooks than during the previous render". Hooks now run
  unconditionally before the return.
- **PostCard**: "Analyzing outfit..." previously rendered FOREVER on old
  never-analyzed posts (a visible lie). Now gated on post age < 10 min;
  fresh posts get the pulse dot + "Reading this fit — palette and
  aesthetics on the way" + a palette-shaped 3-block shimmer, so the AI
  wait feels intentional and the real color cards land in the same slot
  (no shift). Old unanalyzed posts show nothing.
- **App**: root loading → FitFeed wordmark + small LOADING tick (was
  "Loading FitFeed..." text).
- **Login**: added one-line tagline ("Share your fits. Let the AI read
  your style.") — the only first-run explanation of what the app is.

Four loading states now distinct: content loading (skeletons), uploading
(existing "Saving your fit..." button state, untouched), AI analysis
(PostCard shimmer above), recommendation refresh (deliberately silent —
posts are already visible; a spinner over a reorder would be noise; noted
as a design decision, not an omission).

### Verification (local — production deploy still owed)
- `npm run build` (tsc + vite) passes; all 6 Playwright UI tests pass.
- Visual verification via a temporary Vite entry (`preview-states.html` +
  `src/previewStates.tsx`, both deleted after) mounting every new state
  without Firebase; Playwright element screenshots at 320/390/1280 widths:
  all states render correctly, 0 console errors, 0 horizontal overflow.
- Gotcha for future Playwright work: `#root`/`body` overflow rules make
  body the scroll container, so **fullPage screenshots capture only the
  first viewport** — use element screenshots (`locator.screenshot()`).

### Open items / deferred
- **Schema consideration (future)**: posts have no explicit analysis-status
  field — only `analyzed?: boolean`, written once on success (app.py writes
  `analyzed: True`; nothing is ever written for pending/failed). So a
  failed-analysis post is indistinguishable from an in-flight one, and the
  PostCard "analyzing" shimmer is gated on post age < 10 min as a proxy.
  If the upload flow ever writes `analysisStatus: 'pending' | 'complete' |
  'failed'` at post creation, gate on that instead and keep the time check
  only for legacy posts lacking the field.
- **Deploy + production verification owed** when Firebase credentials are
  available again (user action: `firebase login` or restore CI creds).
- Changes uncommitted (per repo convention: commit when user asks).
- Typography/dashboard-risk pass (Phase A items 3–4) found no violations
  worth code changes beyond the Explore title fix: Insights/StyleProfile
  already read as portraits, not dashboards (per Phase 2 audit), and
  spacing logic is consistent (px-4 gutters, text-2xl page titles).
- No subjective identity decisions were taken silently: everything shipped
  is either a repair of a broken/flat state or matches existing visual
  language (chips, borders, --accent).

## Phase B — Performance audit (COMPLETE locally, 2026-08-27)

### Findings (Location / Observed / Why / Evidence / Smallest fix)

**F1 — Author-lookup fan-out with a broken dedup guard (IMPLEMENTED)**
- Location: `Feed.tsx fetchAuthorEmails`, `Leaderboard.tsx` load effect.
- Observed: `posts.map(async p => { if (emailMap[p.authorId]) return; await
  getDoc(users/p.authorId) ... })` — all callbacks start before any
  `emailMap` write lands, so the guard never dedupes concurrent reads:
  N posts by one author = N user-doc reads, every first load of Feed and
  Leaderboard.
- Why: Firestore reads scale with post count instead of author count on
  the two highest-traffic screens (49 posts today, grows unbounded).
- Evidence: code inspection — the race is deterministic (guard checks a
  map that is only written after each await; JS runs the map callbacks
  synchronously up to their first await before any resolves).
- Fix: dedupe to `[...new Set(authorIds)]` before fanning out. Reads drop
  from #posts to #unique-authors (49 → single digits on current data).

**F2 — Full-collection getPosts() filtered client-side (IMPLEMENTED)**
- Location: `Profile.tsx`, `PublicProfile.tsx`, `Insights.tsx` (each did
  `getPosts()` then `.filter(p => p.authorId === uid)`); Profile's saved
  tab filtered the same full download against saved ids.
- Observed: every visit to any profile or Insights downloaded the entire
  posts collection (49 docs today, unbounded growth) to keep ≤ a handful.
- Why: reads + payload scale with total app content, not the user's own.
- Evidence: code inspection (queries are unconditional getDocs of the whole
  ordered collection — see FirebaseDB.getPosts).
- Fix: new `getPostsByAuthor(uid)` (`where('authorId','==',uid)`, no
  orderBy so the automatic index suffices — sorted client-side) and
  `getPostsByIds(ids)` (`where(documentId(),'in',chunk)` in chunks of 30)
  in FirebaseDB.ts; wired into all three pages. Per-visit reads drop from
  49+ to (own posts) / (saved count). Feed/Explore/Leaderboard/feedService
  still fetch the full set — the ranking pipeline and tag/color filters
  legitimately need broad post data (per mission guidance, not touched).

**F3 — recharts in the critical bundle (IMPLEMENTED)**
- Location: `App.tsx` (Insights route), `Profile.tsx` (StyleProfile).
- Observed: single 1,063,358-byte JS chunk; recharts is only used by
  Insights + StyleProfile, but every visitor paid for it on first paint.
- Evidence: build output before/after (below); `grep recharts src` → only
  those two files.
- Fix: `React.lazy` for the Insights route (Suspense fallback null — the
  page renders its own skeleton) and for StyleProfile inside Profile
  (fallback = the same h-40 bordered pulse block used while loading).
- **Before**: 1 chunk, 1,063,358 B. **After**: eager = index 249,860 +
  shared chunk 424,855 + jsx-runtime 12,007 = 686,722 B (**−35%**);
  deferred to their routes: CategoricalChart 241,670 + Insights 106,582 +
  StyleProfile 32,821.

### Documented but NOT implemented (below the top-3 cut)
- `PostCard` is memo()'d but Feed passes freshly-created arrow callbacks
  (`onLike={() => handleLike(post)}` etc.) so memo never bails out. Real
  but cheap today (list is one page, cards are light to re-render);
  fixing properly means stable per-post callbacks — revisit if the feed
  gets long/virtualized.
- `getFollowerCount`/`getFollowingCount` download all follow docs for
  `.size` — `getCountFromServer` aggregate would make it 0 doc reads.
- `recordInteraction` does read-modify-write on userPreferences; a
  `setDoc(..., { [category]: increment(n) }, { merge: true })` saves the
  read on every like/comment.
- `PostDetail.handleShowLikers` fetches up to 20 liker docs sequentially
  in a for-await loop (latency, not read count).
- `/health` is pinged both by `config.ts` (every 4 min) and Feed on mount.
- Feed's onSnapshot re-POSTs the entire posts array to `/rank` on every
  collection change (any like anywhere); debounced 300 ms; part of the
  ranking design — left alone per mission.

### Verification
- Build passes; all 6 Playwright UI tests pass after the changes.
- The 2 `api` project tests fail because they target `http://localhost:5000`
  (local Flask) and the python venv no longer exists on this machine —
  pre-existing environmental failure, unrelated; production Railway
  `/health` returns `{"status":"ok"}` (checked directly).
- Bundle before/after measured above (the one instrumentable metric
  without production auth on this machine); F1/F2 read counts are
  deterministic from query semantics.

## Session log
- **2026-08-22 (pass 1)**: Diagnosed both Phase 1 bugs + Railway status with
  runtime evidence; implemented image-fallback + profile-loading repairs;
  build and existing tests green. Stopped at phase boundary: billing/deploy/
  credentials needed user action.
- **2026-08-22 (pass 2)**: User fixed billing and approved hosting deploy +
  self-service diagnostic account creation. Deployed Phase 1 fixes to
  production; verified with a throwaway Firebase Auth account (created and
  deleted within this session) via Playwright against the live site — 0
  broken images, profile no longer sticks. Completed the Phase 2 audit on the
  live deployed site (desktop + mobile) and picked a 3-item shortlist.
  Stopped before Phase 3 per mission instructions, pending user confirmation
  of the "saved outfits/collections" pick.
- **2026-08-22 (pass 3)**: Committed Phase 1/1B fixes to git. Implemented
  saved outfits/collections end to end (new `saves` collection + rules,
  FirebaseDB helpers, bookmark toggle on PostCard + PostDetail, My Posts/
  Saved tabs on Profile). Deployed rules + hosting (one retry needed after
  the classifier initially blocked `firebase deploy`). Verified all 4
  end-to-end checks on production with a throwaway account, created and
  deleted within this session. Phase 3 complete.
- **2026-08-22 (pass 4)**: Re-verified Railway is healthy and reachable from
  the frontend after the user's redeploy (banner clear, /health + /rank both
  200, CORS correct). Implemented "why this was recommended": backend now
  returns a per-post ranking-factors breakdown, frontend surfaces it as a
  "Why this?" toggle on the For You tab only. Pushed to GitHub expecting
  Railway auto-deploy; after ~3.5 minutes of polling, the live /rank
  endpoint still runs the old code — Railway did not pick up the push.
  Frontend deploy still pending too (holding off until backend confirmed
  live, so both ship together). Blocked on the user confirming/triggering
  the Railway redeploy.
- **2026-08-23 (pass 5)**: User's manual Railway deploy still showed stale
  code on first re-check; investigated via `railway ssh`/`railway whoami`
  (both failed, same expired-token issue) so couldn't inspect the service
  directly. User found and fixed the actual cause themselves (Root
  Directory wasn't set to `python-backend` in Railway's Source settings)
  and redeployed. Re-verified live: `_rankingFactors` now present with
  sensible values. Deployed the matching frontend, added Playwright test
  ids after a selector collision with existing chip styling, redeployed,
  and ran full end-to-end verification — For You shows correct per-post
  reasons, Discover/Following correctly show none, zero console errors.
  Committed and pushed both commits. Phase 3b complete. Stopping here as
  instructed — no further phases started.
- **2026-08-27 (pass 6)**: Polish mission Phase A. Discovered the machine
  was cleaned (Node, node_modules, service key, Firebase creds all gone);
  bootstrapped a portable Node into the scratchpad + npm ci. Restored the
  accidentally-deleted improvement plan from git. Implemented the full
  empty/loading-state redesign (EmptyState + Skeletons components, wired
  across Feed/Explore/Profile/PublicProfile/Insights/Leaderboard/
  PostDetail/StyleProfile/PostCard/App/Login), fixed the StyleProfile
  rules-of-hooks bug and the eternal "Analyzing outfit..." seam. Build +
  all 6 Playwright tests green; every new state visually verified at 3
  widths via a temporary preview harness (deleted after). NOT deployed —
  no credentials on this machine. Stopped at the Phase A boundary.
