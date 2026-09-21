# Transition cleanup checklist

Temporary code becomes permanent when nobody writes down what "done" looks
like. This is that list.

Everything here exists **only** to keep the old and new like clients working
at the same time during one deploy window. None of it is part of the target
architecture. When the criteria below are met, all of it gets deleted in a
single change.

> Copy this into a tracking issue when the rollout starts, so it has an owner
> and a due date rather than living only in the repository.

---

## Do not start until all five hold

- [ ] **Strict rules are live.** Step 11 of
      [production-rollout.md](production-rollout.md) is complete, and step 12
      confirmed a legacy write is rejected in production.
- [ ] **The migration verifies clean.** `python migrate_likes.py --verify`
      reports no discrepancy, run *after* the compatibility window closed.
- [ ] **No drift.** `python reconcile_likes.py` reports `drifted=0` and no
      orphans, or any it found have been swept with `--apply`.
- [ ] **No client writes `likedBy`.** Hosting has served the new bundle for
      longer than any plausible tab lifetime (a week is comfortable), and
      Firestore usage shows no permission-denied writes against `posts/*`.
- [ ] **A rollback would no longer need it.** You are confident enough in the
      new like path that reopening the legacy window is not a scenario you are
      still holding open. Until then the transitional file is cheap insurance
      and should stay.

Removing this code while any of these is false takes away the one-command fix
for a production like outage (`npm run deploy:rules:transition`).

---

## What to delete

### 1. `fit-feed/firestore.transition.rules`

The generated transitional policy. Delete the file.

*Criteria:* all five above.
*Verify after:* `npm run rules:check` must be removed from CI in the same
change, or it will fail looking for a file that no longer exists.

### 2. `fit-feed/scripts/build-transition-rules.mjs`

The generator, and with it the `TRANSITION_MARKER` export that
`deploy-rules.mjs` imports.

*Criteria:* item 1 done.
*Also remove:*
- `rules:build` and `rules:check` from `package.json`
- the "Transitional rules are in sync with their generator" step in
  `.github/workflows/ci.yml`
- `npm run rules:check` from the `verify` script

### 3. `fit-feed/firebase.transition.json`

The alternate Firebase config that points at the transitional rules file.

*Criteria:* item 1 done.

### 4. The transition deploy command

In `fit-feed/scripts/deploy-rules.mjs`, remove the `transition` mode, its
marker checks and the `TRANSITION_MARKER` import.

*Criteria:* items 1–3 done.
*Decision:* with only one mode left, the script is no longer doing much. Keep
it anyway — its value is refusing to deploy without an explicit argument, and
that is worth more than the lines it costs. Remove `deploy:rules:transition`
from `package.json`; keep `deploy:rules:strict`.

### 5. `isLegacyLikeToggle()` and its helpers

Already absent from `firestore.rules` — it only ever existed in the generated
file. Deleting item 1 removes it. **Nothing to do in `firestore.rules`.**

*Verify:* `grep -r "isLegacyLikeToggle\|legacyLikedByBefore" fit-feed/` returns
nothing outside `docs/`.

### 6. Legacy client compatibility logic

| Where | What | Notes |
| --- | --- | --- |
| `fit-feed/src/FirebaseDB.ts` | `likedBy?: string[]` on the `Post` type | Only kept so old documents type-check |
| `fit-feed/firestore.rules` | `likedBy` in `validPostCreate()`'s allowed keys, and `incoming().likedBy == []` | New posts no longer need to create the field at all |
| `fit-feed/src/pages/Upload.tsx` | `likedBy: []` in the created post | Remove with the rule above, in that order: rule first would reject the client |
| `fit-feed/tests/rules/setup.ts` | `likedBy: []` in `postDoc()` | Test fixture |

*Criteria:* all five conditions, **plus** item 7 below — the field must be
gone from the data before it is gone from the type.

### 7. The `likedBy` data itself

The last thing to go, and the only irreversible one.

*Criteria:* everything above, plus a further period with the field unread. At
that point write a small script in the shape of `migrate_likes.py` — dry run
by default, `--apply` to write — that deletes the field with
`firestore.DELETE_FIELD`.

*Before running it:* export the collection.

```bash
gcloud firestore export gs://<bucket>/pre-likedby-removal --collection-ids=posts
```

*Why last:* while this field exists, a rollback to the old client is possible.
Once it is gone, it is not.

### 8. Transitional tests

`fit-feed/tests/rules/transition.rules.test.ts` deletes with item 1.

**Keep** `fit-feed/tests/rules/migration.lifecycle.test.ts` — trim its
transitional blocks, but its concurrency, idempotency, count-consistency and
cleanup cases test the permanent architecture and should survive.

### 9. Documentation

| File | Action |
| --- | --- |
| `docs/production-rollout.md` | Move to `docs/history/`; it describes a migration that has happened |
| `docs/transition-cleanup.md` | This file — delete it last, in the same change |
| `docs/deployment.md` | Collapse the two-phase rules deploy back to one step |
| `docs/security.md` | Remove the migration-debt limitation |
| `README.md` | No change; the "production hardening" table is history and stays |

---

## Order of operations

The order matters — several items break the ones above them if done first.

```
1. Confirm all five criteria
2. Delete the likedBy DATA          (item 7, after an export)
3. Remove client/rules likedBy handling  (item 6, rule before client)
4. Delete the transitional rules file    (item 1)
5. Delete the generator, config, CI step, npm scripts  (items 2, 3, 4)
6. Trim the tests                   (item 8)
7. Update the documentation         (item 9)
8. npm run verify -- everything must still pass
```

## Verification when finished

```bash
cd fit-feed
npm run verify

grep -rn "likedBy\|isLegacyLikeToggle\|transition" \
  src/ python-backend/ tests/ firestore.rules \
  --include='*.ts' --include='*.tsx' --include='*.py' --include='*.rules'
```

**Good:** `verify` passes and the grep returns nothing outside `docs/history/`.
