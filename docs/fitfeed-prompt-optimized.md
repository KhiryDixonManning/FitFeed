# FITFEED — POLISH, PERFORMANCE & COMPETITIVE AUDIT

## START HERE

1. Read `docs/fitfeed-improvement-plan.md` FIRST. It is the source of truth and running record. Do not re-derive work documented there. Update it after each phase.
2. If this prompt disagrees with the current repository, **the repository wins**. Note the discrepancy briefly; don't force code to match this description.
3. Work in three phases (A → B → C). **STOP and report at the end of each phase before continuing.**

## CONTEXT

FitFeed is a deployed fashion social platform (capstone by Khiry — ML/recs/Flask/image analysis; Max — frontend; Jimwall — backend). Goal: close the gap from "impressive capstone" to "early-stage funded fashion-tech product." **Do not rebuild FitFeed. Finish it.** Preserve existing architecture and behavior unless the task requires a change.

**Stack:** React + TypeScript + Vite + Tailwind + React Router + Recharts + Playwright | Firebase (Auth, Firestore + `onSnapshot`, Storage, Hosting) | Python Flask AI service (Claude multimodal, Pillow/NumPy, KMeans color extraction) on Railway/Gunicorn.

**Pipeline:** upload → Storage → Firestore doc → Flask analyzes image (local color extraction + Claude fashion analysis) → structured analysis written to Firestore → frontend updates via listeners → feeds user's style profile and recommendations.

**Features:** feed, Explore, personalized For You, post detail, likes/comments, profiles, upload, AI outfit analysis (garments, colors, aesthetics, descriptions, style scores), color-palette chips, style profile, insights, leaderboard/Aura concepts, responsive nav.

**Recommendations:** real ranking system (engagement, Wilson-style scoring, velocity, freshness/recency decay, preference alignment, diversity penalty, exploration; comments weighted stronger than likes; fallback when the rec API is down). **Do not rewrite it** except for a narrowly scoped fix a concrete performance problem requires.

## DESIGN DIRECTION (applies everywhere)

Fashion photography is the protagonist; AI makes the experience smarter, not louder. Target feel: editorial, intelligent, expressive, premium, visually driven, confident but restrained.

Sensibility references (not literal themes): Japanese Americana/Amekaji, luxury streetwear, contemporary tailoring, muted foundations with intentional statement pieces, strong silhouette/proportion, texture, whitespace, editorial hierarchy, intentional asymmetry.

**Existing quality bar** (match this; don't flatten it): photography-driven feed cards, the Aura badge treatment, color-palette chips. Bring weak screens up to this level; don't drag strong screens down into a generic unified component system.

**Avoid:** generic SaaS/admin-dashboard aesthetics, glassmorphism, random gradients, oversized rounded cards, excessive card nesting/pills/stats/AI badges/sparkle icons, purple-tech-startup visuals, decorative motion, dashboard-tiling every datum, feature bloat, redesigning good components for novelty. Highest dashboard risk: **Insights** and **Style Profile** — they should read as "an intelligent portrait of how I dress," not account analytics.

## SCOPE DISCIPLINE (all phases)

- Inspect repo structure once. Ignore `node_modules`, `dist`, `build`, `coverage`, `.git`, generated assets, unrelated notebooks/datasets.
- Search for relevant files/symbols instead of reading broadly. Summarize; don't dump files or routine output.
- No dependency upgrades, unrelated refactors, rewrites of working code, or architectural changes without a demonstrated blocker.
- Prefer small high-confidence fixes. Verify changes; never assume they work.

---

# PHASE A — UI/UX AUDIT & FIX

Deferred visual pass from the earlier audit (see improvement plan for prior findings — don't repeat them). Fix in this priority order:

**1. Empty states** — feed, Explore, no posts/comments/insights, incomplete style profile, no search results, first-run. Currently flat gray text; make each intentional using typography, layout, imagery where apt, contextual action, restraint. Not every empty state becomes a giant illustration card.

**2. Loading states** — prefer skeletons, image placeholders, progressive loading, preserved layout dimensions over afterthought spinners. Avoid layout shift, especially on image-heavy surfaces. Distinguish four states instead of one generic spinner: loading existing content / uploading / waiting on AI analysis (can take seconds — make the wait feel intentional) / refreshing recommendations.

**3. Typography & spacing** — audit Feed, Explore, PostDetail, Profile/PublicProfile, Insights, Style Profile, Upload. Check heading/metadata/body/label hierarchy, spacing rhythm, gutters, card padding, image-to-text spacing, desktop/mobile consistency. Goal is **consistency of logic**, not mathematical sameness — editorial rhythm may vary intentionally.

**4. Generic-dashboard risk** — especially Insights and Style Profile. Keep the information; fix hierarchy, chart framing, labels, density, whitespace, and use style imagery/colors to support data. Ask whether everything actually needs its own container.

**5. Mobile rough edges** — test small phone / modern phone / tablet / desktop widths. Look for wrapping, clipping, overflow, horizontal scroll, bottom-nav interference, touch targets, unusable charts, modal/fixed-element issues, palette-chip wrapping, long captions, comment layouts, profile headers. Prioritize actual breakage.

**Decision rule:** fix what's clearly broken, inconsistent, unfinished, or below the existing quality bar. For subjective changes that alter visual identity, don't choose silently — present: what feels wrong, why, 1–2 directions, your recommendation, and ask. Don't invoke this rule for trivia like obviously inconsistent spacing.

**Verification:** run relevant tests; check routes, console errors, affected screens, mobile layouts, empty/loading states. Provide screenshots or concise visual descriptions of each materially changed state. If deploy credentials exist: deploy and verify the live build — never claim deployment success without verifying.

**Done when:** empty/loading states and flagged inconsistencies fixed and visually verified; deployment confirmed if available; improvement plan updated (findings, fixes, verification, open subjective decisions, deployment status). **STOP AND REPORT.**

---

# PHASE B — PERFORMANCE AUDIT (real waste, not theory)

Focus on what matters for a React + Firestore + image-heavy + personalized app with an external Flask service. No generic optimization checklists.

**Investigate:**
- **Firestore reads:** reads in loops, N+1 lookups (per-post user/interaction fetches), repeated queries for data already in hand, duplicate/unsubscribed listeners, identical queries across components, full-collection loads where a page suffices. Prefer batching, query restructuring, pagination; denormalize only with justification. Don't casually change the schema.
- **React rendering:** genuinely expensive repeated work in feed lists, post cards, palette calcs, charts, derived style-profile calcs. Look for unstable props, expensive derived computation, parent-driven rerenders, callback recreation that breaks child memoization. Add `memo`/`useMemo`/`useCallback` **only where the observed pattern justifies it** — never mechanically.
- **Client-side dataset work:** fetching whole datasets then filtering/sorting client-side where a Firestore query, pagination, or bounded subset would do. Careful: the ranking pipeline may legitimately need custom processing — understand it first.
- **Duplicate requests:** repeated Storage URL retrieval, profile/post/preference fetches, AI-status checks, unstable effect dependencies, multiple components fetching the same doc.
- **Bundle:** lazy-load meaningful candidates (Insights, charts, large secondary routes, single-page-only libraries). Don't fragment tiny modules for vanity metrics.

**Evidence standard:** Profiler data, network/Firestore request patterns, bundle output, render counts, timings, or code inspection showing an actual N+1/duplicate pattern. Report each finding as: **Location / Observed behavior / Why it matters / Evidence / Smallest fix.** Don't flag things just because a lint rule says "could be optimized."

**Implement only the top 2–3 issues**, prioritized: (1) repeated network/DB work, (2) expensive rendering/recomputation, (3) initial-load, (4) minor. No micro-optimizations; no rec-system rewrite.

**Verification:** before/after evidence (request counts, reads, render counts, bundle sizes, timings — whichever applies). Run tests. Update improvement plan (findings, chosen fixes + why, evidence, deferred items). **STOP AND REPORT.**

---

# PHASE C — COMPETITIVE POLISH (written proposal only — DO NOT IMPLEMENT)

Identify the smallest changes that shift FitFeed from "polished school project" to "funded-startup-grade product." Not a feature brainstorm.

Benchmark against strong consumer fashion-tech/fashion-AI products. Lekondo is one reference for making fashion analysis visually compelling — inspect it only if publicly inspectable; otherwise use other public fashion-tech or high-quality consumer patterns. **Do not invent competitor functionality or copy branding/layouts/wording.**

**Compare on:**
- **First-run experience:** does the product communicate value with zero posts/analysis/history?
- **Onboarding:** does a new user grasp what FitFeed is, what to do first, why posting matters, what AI analysis gives them, how the style profile improves — without explanatory text everywhere?
- **Analysis reveal:** does photo → analysis → style info feel like a product moment or just data appearing? Evaluate hierarchy, anticipation, timing, composition — not necessarily flashy animation.
- **Style identity:** does accumulated style data feel like persistent personal identity or a stats page? How can aesthetics, colors, history, garments, preferences, and recs feel connected without new features?
- **Social proof / liveness:** would a recruiter feel "people use this"? Hunt capstone artifacts: sparse screens, awkward zero counts, placeholder copy, screens that only look good fully populated. Don't fabricate activity.
- **Perceived speed:** optimistic UI, image transitions, stable layout, progressive analysis state, skeleton quality, route transitions, interaction feedback.
- **Design-system cohesion** across Feed, Explore, PostDetail, Profile, Insights, Style Profile, Upload — while keeping intentional differences between social/editorial/analytical surfaces.

For each inspectable competitor pattern, note: **They do / FitFeed currently does / Lesson / FitFeed adaptation.**

**Output: exactly 2–3 proposals**, each with: **Problem / Proposed improvement / Why it matters / Scope (screens, components) / Complexity (L-M-H) / Expected perception gain (L-M-H) / Risks.** Prioritize by perception-gain-per-effort.

**Do not propose:** full redesign, rec-engine rebuild, feature lists, a chatbot, unrelated social features, infrastructure changes, mobile apps, bloat.

**Done when:** improvement plan updated with competitive findings and the final 2–3 proposals. Then stop.

---

# SUCCESS CRITERIA

- **A:** weakest visible states no longer expose capstone seams; empty/loading/typography/responsive/Insights/Style Profile match the product's strongest parts.
- **B:** 2–3 genuine performance fixes with before/after evidence.
- **C:** prioritized 2–3-item roadmap toward "credible early-stage fashion-tech product."

The core product stays recognizable throughout.
