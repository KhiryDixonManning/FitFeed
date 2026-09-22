# Historical development notes

The files in this directory are **working notes from earlier development
sessions**, kept for provenance. They are not documentation of how FitFeed
currently works.

They may describe:

- **Previous architectures** that have since been replaced — client-side feed
  ranking, synchronous in-request AI analysis, the `likedBy` array on post
  documents, category counters as the personalization signal.
- **Deployment states that are no longer accurate.** Several of these notes
  assert that work is "COMPLETE, DEPLOYED and VERIFIED on production". That
  was true when written. The repository has since moved well ahead of what is
  deployed, so treat any deployment claim here as historical.
- **Plans that changed**, were superseded, or were deliberately not done.

Nothing here should be used to answer a question about current behaviour. If
a file in this directory disagrees with the code or with the documents below,
**the code wins, and then the documents below.**

## Current documentation

| Document | Covers |
| --- | --- |
| [../architecture.md](../architecture.md) | Components, data model, feed and analysis paths |
| [../recommendation-system.md](../recommendation-system.md) | Scoring maths, taste modelling, evaluation, limitations |
| [../security.md](../security.md) | Threat model, controls, accepted limitations |
| [../testing.md](../testing.md) | Test layers and the adversarial suites |
| [../deployment.md](../deployment.md) | Release order, migrations, rollback |

## Contents

| File | What it was |
| --- | --- |
| `fitfeed-improvement-plan.md` | Running session log and context file used across development sessions |
| `fitfeed-prompt-optimized.md` | The brief for the polish / performance / competitive audit phase |

These are kept rather than deleted because they record *why* decisions were
made, which the current documents mostly do not — the current documents
describe what is true now.
