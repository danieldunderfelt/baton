---
title: "Ratings and profiles"
description: "How Baton learns which model is best for each kind of task, and how profiles make that portable."
order: 3
---

Baton works without ratings or a setup interview. When you want to record experience or preferences, it keeps these kinds of evidence separate:

- **Grades.** After using a delegated answer, the agent (or you) grades it 1–5: `baton grade <run-id> 4 "needed one fix"`. Grades decay with a 90-day half-life, so old evidence fades.
- **Seeded priors.** A profile import loads your starting opinion of each model before any evidence exists. Seeds are capped at the weight of a few observations, so a wrong guess cannot steer routing for months.
- **Duels.** Two models answer the identical prompt, and you judge the answers blind. Verdicts feed a Bradley-Terry strength score, reported separately from grades.

## Grading

```sh
baton grade run_abc123 4 "needed one fix"
```

Grade a run after you have used its result, not when it arrives, and score how useful the answer turned out to be. Re-reporting the same run replaces the earlier grade, so a correction never double-counts.

Agents can use `report_result(run_id, grade, notes?)`. A failed execution without an answer cannot receive a quality grade; Baton records execution reliability separately. If the user requests model preferences, `seed_ratings(profile_name, entries)` records them without a mandatory interview or another confirmation step. Use canonical model IDs and distinguish quality from speed or cost.

## Duels

```sh
baton duel kimi-k3 gpt-5.6-sol "Review src/quota/quota.ts for likely regressions"
baton duel report duel_xyz A
baton duel list
```

`baton duel` runs both models on the identical prompt and shows the answers labelled A and B with the models hidden. You judge on the answers alone, then `baton duel report <id> A|B|tie` commits the verdict and reveals which was which. `baton duel list` shows recent duels and their status.

Duels use the same working directory, so use them for non-mutating tasks.

## Reading the table

`baton ratings` shows observed grades, the active prior and their blended value, with duel evidence reported separately. SQLite owns these records.

`baton ratings export` writes a consistent `ratings.yaml` snapshot in the config directory. This is an explicit export, not a file maintained after every grade or setting change. Baton never reads it for routing. Export again when you need current values, including time-dependent decay. `ratings publish` remains an alias for older scripts.

## Profiles

A profile is a named set of priors: for each entry, a canonical model id, an optional category, a mean on the 1–5 scale, and a weight in pseudo-observations. The active profile is the prior new evidence blends with.

`baton profile export` produces a portable document without local run history or account configuration.

```sh
baton profile import ./team.yaml --dry-run
baton profile import ./team.yaml
baton profile import ./another.yaml --name alternative --activate
baton profile export --out ./my-profile.yaml
```

Import applies immediately and prints the added, changed and removed priors. `--dry-run` previews without changing priors. The first profile activates automatically; subsequent imports leave the current profile selected unless `--activate` is supplied. `baton set active_profile <name>` switches later.

Replacing an existing profile saves its previous values to a file under `profile-backups` in the scope's config directory. The import prints the backup path and a command to restore it. A replacement removes priors missing from the new document. Profile names and categories are free text and are exported verbatim.

To move a profile between machines without passing files around, see [Sharing profiles](/docs/sharing).
