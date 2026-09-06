---
title: "Ratings and profiles"
description: "How Baton learns which model is best for each kind of task, and how profiles make that portable."
order: 3
---

Baton routes on evidence and keeps the kinds of evidence separate:

- **Grades.** After using a delegated answer, the agent (or you) grades it 1–5: `baton grade <run-id> 4 "needed one fix"`. Grades decay with a 90-day half-life, so old evidence fades.
- **Seeded priors.** A profile import loads your starting opinion of each model before any evidence exists. Seeds are capped at the weight of a few observations, so a wrong guess cannot steer routing for months.
- **Duels.** Two models answer the identical prompt, and you judge the answers blind. Verdicts feed a Bradley-Terry strength score, reported separately from grades.

## Grading

```sh
baton grade run_abc123 4 "needed one fix"
```

Grade a run after you have used its result, not when it arrives, and score how useful the answer turned out to be. Re-reporting the same run replaces the earlier grade, so a correction never double-counts.

## Duels

```sh
baton duel kimi-k3 gpt-5.6-sol "Review src/quota/quota.ts for likely regressions"
baton duel report duel_xyz A
baton duel list
```

`baton duel` runs both models on the identical prompt and shows the answers labelled A and B with the models hidden. You judge on the answers alone, then `baton duel report <id> A|B|tie` commits the verdict and reveals which was which. `baton duel list` shows recent duels and their status.

## Reading the table

`baton ratings` prints the current table: observed grades, the seeded prior, and the blended number selection ranks on, with the Bradley-Terry duel score alongside as a separate signal. `baton ratings publish` refreshes `ratings.yaml` in the config directory. That file is the same table as a file, regenerated on every change; it is display-only and Baton never reads it back.

## Profiles

A profile is a named set of priors: for each entry, a canonical model id, an optional category, a mean on the 1–5 scale, and a weight in pseudo-observations. The active profile is the prior new evidence blends with.

`baton profile export` writes a shareable file containing only model opinions — never your prompts, accounts, or machine details. `baton profile import <file>` loads one: it prints a diff of added, changed and unchanged priors and writes nothing until re-run with `--yes`. `--name <n>` imports under a different profile name, `--activate` switches to it after import, and `baton set active_profile <name>` switches later.

To move a profile between machines without passing files around, see [Sharing profiles](/docs/sharing).
