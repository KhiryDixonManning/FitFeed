# FitFeed backend

Two processes, declared in `Procfile`:

| Process  | Command                | What it does                                              |
| -------- | ---------------------- | --------------------------------------------------------- |
| `web`    | `gunicorn app:app …`   | The HTTP API: feed, trending, interactions, enqueue.       |
| `worker` | `python worker.py`     | Runs outfit analysis from the job queue.                   |

Both need the same environment (see `.env.example`) and the same Firebase
credentials. Neither depends on the other being up: the API enqueues work
even when no worker is running, and the worker drains the queue even when the
API is down.

## Why there are two

`POST /analyze` used to call the model inside the HTTP request. That made the
work only as durable as the browser tab that started it — closing the tab
during a 20-second model call left a post permanently half-analyzed, and a
slow call held a Gunicorn thread the whole time.

Now `/analyze` writes a job and returns `202 {"status": "queued"}`. The
worker leases the job, runs the analysis, and writes the result. Closing the
browser has no effect on it.

## Deploying the worker on Railway

The worker is a **separate service in the same project**, not a second
replica of the web service:

1. New service → same repo, same root directory (`python-backend`).
2. Start command: `python worker.py`.
3. Copy the environment from the web service. `ANTHROPIC_API_KEY` and the
   Firebase credentials are the ones it genuinely needs.
4. Leave it at **one replica** unless you have raised your Anthropic rate
   limit. Two workers are safe — leases make double-processing impossible —
   but they will consume quota twice as fast.

There is no health-check endpoint to configure; the worker is not an HTTP
service. It exits cleanly on `SIGTERM`, so a redeploy finishes the job in
flight rather than abandoning it.

## The job queue

One document per post at `analysisJobs/{postId}`:

```
status        queued | processing | complete | failed
attempts      how much of the spend budget is used (max 3)
availableAt   not before this time (backoff between attempts)
leaseExpiresAt  a worker holds it until here
lastErrorCode   why the last attempt failed
```

The post id **is** the job id, so enqueuing the same post twice updates one
document rather than buying a second model call. Clients cannot write these
documents at all (`allow write: if false`); the post's author can read theirs,
which is what drives the status shown on the post detail page.

Failures are classified before they are retried. Permanent ones are data
problems that would recur identically on every attempt - the post was
deleted, the image is unusable or from an untrusted host, the job's uid no
longer matches the post's author - and they fail the job immediately rather
than burning the budget. Transient ones (the model returned nothing usable,
a Firestore or network wobble) earn a retry with exponential backoff and
jitter. After three attempts the job is terminal, and the UI says so instead
of offering a retry button - see below.

## Re-arming an exhausted post

Attempts are a spend budget, so nothing a user can press resets them. A post
that has burned all three attempts stays failed until an operator intervenes.
The retry button on a post detail page reflects this: it is offered for a
post that failed with attempts left, and replaced by plain copy once the
budget is gone.

`POST /reanalyze-all` is the operator tool. It is gated behind
`ADMIN_API_KEY` (sent as `X-Admin-Key`; the route 404s when that variable is
unset), **queues work rather than doing it**, and is a dry run unless told
otherwise:

```bash
# What would be queued? Changes nothing.
curl -X POST $API/reanalyze-all -H "X-Admin-Key: $ADMIN_API_KEY"

# Actually queue it.
curl -X POST $API/reanalyze-all \
     -H "X-Admin-Key: $ADMIN_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"apply": true}'

# Also re-arm posts that have spent all three attempts.
curl -X POST $API/reanalyze-all \
     -H "X-Admin-Key: $ADMIN_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"apply": true, "resetAttempts": true}'
```

`{"apply": true}` must be the boolean — a truthy string does not count. The
sweep reads at most 500 posts per call (`"limit"` lowers that), so it cannot
walk an unbounded collection inside one HTTP request.

For a single post:

```python
from auth import get_db
from analysis_jobs import reset_attempts
from job_queue import enqueue_analysis

db = get_db()
reset_attempts(db, "<postId>")
enqueue_analysis(db, "<postId>", "<authorUid>")
```

## Running locally

```bash
npm run dev            # frontend + API + worker together
npm run dev:worker     # just the worker
python worker.py --once  # a single pass, then exit
```

## Tests

```bash
npm run test:backend   # pytest under the Firestore emulator
```

`tests/conftest.py` removes `ANTHROPIC_API_KEY` from the environment before
anything imports the analyser, so the suite cannot make a paid call even if a
developer has a key exported. Every test that exercises the analysis path
substitutes its own function.
