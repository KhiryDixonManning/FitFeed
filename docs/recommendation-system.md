# Recommendation system

Everything here is deterministic and inspectable. There is no learned model,
no embedding service and no training loop — the ranking is a weighted sum of
bounded, hand-specified signals, reranked for diversity. That is a deliberate
choice for a system of this size: every score can be explained to the user
who received it, and every regression can be written as a unit test.

## 1. Candidate generation

Ranking never sees the whole collection. Each feed mode produces a bounded
candidate set server-side:

| Mode | Query | Bound |
| --- | --- | --- |
| `discover` | `posts` ordered by `createdAt desc` | `CANDIDATE_WINDOW` |
| `following` | `authorId IN [...]`, chunked 10 at a time | 10 chunks → 100 authors |
| `foryou` | recent window, then personalized | `CANDIDATE_WINDOW` |

Posts the viewer marked *not interested* are removed from the candidate set
before scoring (bounded at `MAX_NOT_INTERESTED_SCANNED = 200`).

Following lists longer than 100 are **sampled, not truncated**: the sorted
author list is rotated by `SHA256(uid : YYYY-MM-DD) mod n`, so the sample is
stable within a day and covers everyone across days. The response reports
`followingTotal` and `followingSampled`.

## 2. Score

For a candidate post *p* and user *u*:

```
score(p, u) = freshness(age) × [
      0.30 · engagementQuality(p)
    + 0.25 · styleMatch(p, u)
    + 0.20 · velocity(p)
    + 0.10 · conversation(p)
    + 0.15 · exploration(u, p, day)
]
```

Each term is bounded to [0, 1], so the bracket is in [0, 1] and the final
score is in [0, 1.5].

Personalization is capped at 0.25 on purpose. A narrow or brand-new taste
profile must not be able to crowd out fresh or high-quality content, and a
user whose profile is empty should still get a sensible feed.

### Engagement quality

Weighted volume, saturating:

```
E(p) = 1.0·likes + 2.5·comments + 3.0·saves

engagementQuality(p) = min( ln(1 + E) / ln(1 + 100), 1 )
```

A comment costs more effort than a like, and a save more still, so they are
weighted accordingly. The log makes returns diminish: the difference between
5 and 15 engagements matters far more than between 500 and 510.

**What this replaced, and why.** The original code fed `likes / (likes +
comments)` into a Wilson score interval. That treats a comment as a *failed
like* — adding a comment could lower a post's score. Worse, a Wilson interval
estimates a success *rate* and needs a trial count; without impressions there
is no denominator, so the statistic was not measuring anything. The Wilson
implementation is still present and used the moment impressions exist as a
trusted aggregate:

```
rate = min( E / (impressions × 2.5), 1 )
engagementQuality = WilsonLowerBound(rate, impressions, z = 1.96)
```

Until then the saturating form is used, and it is monotonically
non-decreasing in every input, which the ratio form was not.

### Velocity

How fast engagement is arriving, with sublinear age discounting:

```
velocity(p) = min( ln(1 + E / age_hours^0.8) / ln(1 + 5), 1 )
```

The 0.8 exponent softens the denominator so a three-hour-old post is not
penalised as if engagement rate decayed linearly.

### Conversation

Rewards discussion relative to passive liking, defined even with zero likes:

```
share  = comments / (comments + likes)
volume = min( ln(1 + comments) / ln(1 + 10), 1 )
conversation(p) = min( share × volume, 1 )
```

The `volume` factor stops a post with one comment and no likes from scoring a
perfect 1.0 on share alone.

### Freshness

A multiplier, not an addend, so an old post decays rather than permanently
occupying the feed on accumulated engagement:

| Age | Multiplier |
| --- | --- |
| < 1h | 1.5 |
| < 6h | 1.2 |
| < 24h | 1.0 |
| < 72h | 0.8 |
| ≥ 72h | 0.6 |

### Exploration

```
exploration(u, p, d) = SHA256(uid : postId : YYYY-MM-DD)[0:8] / 2^64  ∈ [0, 1)
```

Deterministic given (user, post, day). This matters operationally: Python
salts `hash()` per process, so with several Gunicorn workers the same request
could rank differently depending on which worker served it. It also means a
user's feed does not reshuffle on every refresh, but does change day to day.

## 3. Style vectors

A post's analysis fields are projected into a four-facet sparse vector over a
**closed vocabulary** — unknown terms are canonicalized or dropped, so the
space cannot grow without bound from model output:

```
post_style_vector(p) = { aesthetics: {...}, tags: {...}, items: {...}, colors: {...} }
```

Canonicalization is word-boundary matched. (An early substring version mapped
"quantum flux capacitor" to the *accessory* facet, via "cap".)

Similarity is cosine per facet, combined with fixed facet weights:

```
styleMatch(p, u) = Σ_f w_f · cos( taste_f(u), post_f(p) )
```

## 4. Taste vectors

A user's taste vector is the weighted, decayed sum of the style vectors of
posts they engaged with, normalized per facet to [0, 1] and capped at 24
dimensions per facet.

```
taste(u) = normalize( Σ_i  w(signal_i) · decay(t_i) · style_vector(post_i) )
```

### Signal weights (v2)

| Signal | Weight | Decayed? |
| --- | --- | --- |
| `more_like_this` | +6.0 | No |
| `save` | +3.0 | Yes |
| `comment` | +2.5 | Yes |
| `like` | +1.5 | Yes |
| category counter | +1.0 | Yes |
| `view` (dwell) | +0.4 | Yes |
| `impression` | +0.1 | Yes |
| `not_interested` | −4.0 | No |

Passive signals are an order of magnitude weaker than explicit ones by
design: impressions are plentiful and nearly free to generate. They are also
deduplicated per (user, post) at the schema level, so a post contributes at
most one impression and one view no matter how often it is re-shown — passive
signal cannot be farmed.

Explicit feedback is exempt from decay. A deliberate "less of this" should
not quietly expire.

Negative weights subtract from the dimensions they touch, then the whole
vector is floored at zero and renormalized. A dislike can drive a dimension
to zero but never negative, so the space stays bounded in both directions.

### Decay

```
decay(t) = 0.5 ^ ( max(now − t, 0) / 30 days )
```

The `max(·, 0)` clamp is a security property, not a rounding detail:
`createdAt` is a client-supplied string, and without the clamp a forged
future timestamp would produce a decay factor greater than 1 and *amplify* a
signal. With it, claiming the future buys nothing and backdating only weakens
a signal.

Decay is measured from **when the user acted**, not from the post's age —
scrolling past a two-year-old post today is a signal about today.

### Caching and invalidation

The vector is cached at `userTasteVectors/{uid}` with a 6-hour TTL. A TTL
alone would mean a like taking up to six hours to affect the feed, so there
is also a monotonic generation marker at `userTasteState/{uid}`: a cached
vector records the generation it was built from and is stale the moment the
marker moves.

Every taste-relevant mutation stages its own bump **inside the same batch or
transaction** as the mutation (`stageTasteBump`). A like, unlike, save,
unsave, comment, more-like-this and not-interested therefore cannot commit
without their invalidation, and a rejected mutation takes its invalidation
down with it. That is enforced rather than remembered: a follow-up write is
something a refactor can silently drop.

The rules require the marker to move strictly forward, by at most 10, and
refuse deletion — otherwise a client could lower it and pin itself to a stale
profile.

### Cold start

A user with no history gets `isEmpty: true` and `styleMatch = 0` for every
post, which reduces the score to the non-personalized terms. The feed is
still full, ordered and diverse. As signals accumulate the personalization
term switches on gradually; there is no threshold at which behaviour jumps.

## 5. MMR diversity reranking

Greedy maximal marginal relevance over the scored candidates:

```
pick argmax_p [ score(p) − λ · score(p) · max_{s ∈ selected} sim(p, s) ],   λ = 0.35
```

The penalty is proportional to the candidate's **own** score, so it is
bounded by `λ · score(p)`: a much weaker post cannot leapfrog a much stronger
one on diversity alone. The highest-scoring candidate is placed first,
unpenalised — trade-offs begin at slot two.

`sim(a, b)` is category equality (0.6) plus aesthetic equality (0.25) plus
Jaccard tag overlap (×0.15), capped at 1.

**MMR intentionally trades some later-position relevance for diversity.**
This is the point of the algorithm, not a side effect. On the evaluation
fixture it retains 98.5% of position-discounted base relevance while
improving early-slot category variety; the exact figure depends entirely on
the candidate set and should not be quoted as a general property.

## 6. Ranking explanations

Every ranked post carries `_rankingFactors`: the per-term contributions, the
freshness tier, the post's age, the matched category, and whether MMR
adjusted it and by how much. The UI turns this into a "why am I seeing this?"
panel. It is derived from the same values that produced the score, so it
cannot drift from the real reason.

## 7. Evaluation

`python-backend/evaluate_recommendations.py` measures **behavioural and
system properties** over deterministic synthetic fixtures:

| Metric | Question |
| --- | --- |
| `personalisation_sensitivity` | Do different taste profiles produce different feeds? |
| `diversity_at_k` | Distinct categories in the top k, before and after MMR |
| `category_coverage` | Can the feed reach the whole corpus? |
| `determinism` | Same inputs → same order; different user → different order |
| `cold_start` | Does a profile-less user still get a full, bounded feed? |
| `relevance_diversity_tradeoff` | What does MMR actually cost? |
| `negative_feedback_effect` | Does hiding a style remove it? |

**These are not accuracy metrics.** FitFeed has no labelled relevance
dataset — nobody has recorded which post a given user *should* have been
shown — so precision, recall, NDCG and friends are not computable and are not
reported. `tests/test_evaluation.py` asserts that no metric is ever named
like one.

The weights above are **not** tuned against these fixtures. Doing so would
make every number the harness prints meaningless.

## 8. Current limitations

- **No ground truth.** Nothing here is validated against real user
  satisfaction. The weights are reasoned, not fitted.
- **Impressions are collected but not yet used as a denominator.** The Wilson
  path exists and is dead until impression counts are trusted aggregates
  rather than per-user documents.
- **Following is sampled above 100 accounts.** Correct within a day, complete
  only across days.
- **Similarity for MMR is hand-weighted**, not the style vectors — the two
  could be unified.
- **Cold start is non-personalized, not actively exploratory.** There is no
  bandit; the exploration term is uniform noise, not an uncertainty estimate.
- **The category counters (`userPreferences`) are still a v1 signal** blended
  in at weight 1.0, kept for users whose history predates style vectors.
- **No diversity guarantee across pages.** MMR runs per page, so the same
  category can dominate page 2 even if page 1 was varied.
