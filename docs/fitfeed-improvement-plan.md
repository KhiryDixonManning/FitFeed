# FitFeed Improvement Plan — persistent session context

> Read this first each session. Don't re-derive anything recorded here.
> Last updated: 2026-08-22 (Phase 1 + 1B VERIFIED on production. Phase 2 audit
> complete. Stopped before Phase 3 per mission instructions — awaiting nothing,
> ready to proceed next session/turn).

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

## Phase 3b — "Why this was recommended" (2026-08-22, CODE COMPLETE,
## BLOCKED ON RAILWAY REDEPLOY)

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

### BLOCKED: not deployed to Railway
Pushed to `origin/main` (you confirmed you wanted this route, expecting
Railway to auto-deploy from GitHub). Polled `POST /rank` for ~3.5 minutes
afterward — it still returns the old (no `_rankingFactors`) response shape,
so **the push did not trigger a Railway redeploy** within that window. The
service itself is healthy and responding correctly with the old code, so
this isn't a crash — just stale code. Two likely explanations: Railway's
GitHub integration isn't actually connected/enabled for this repo, or it's
watching a different branch/root directory. Needs you to either confirm the
GitHub integration is live (and give it more time) or trigger a manual
redeploy from the Railway dashboard / `railway up`.

**Next step for whoever picks this up**: once Railway is confirmed running
the new code (`curl -X POST .../rank` with a dummy post should return
`_rankingFactors` in the response), do a live Playwright pass on the For
You tab: confirm the "Why this?" button appears, click it, confirm the
chips render sensible reasons, and confirm it's absent on Discover/Following
and absent entirely if the fallback (unranked) path is hit.

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
