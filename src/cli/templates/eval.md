### Grading what came back

Baton routes on evidence, and the evidence is your grades. Grade a delegation **after you have used its result** — not when it arrives, and not on how the answer reads.

- `report_result(run_id, grade, notes?)`, where `grade` is 1–5:
  - **5** correct and directly usable
  - **4** usable after small fixes
  - **3** partly usable; half of it had to be redone
  - **2** mostly wrong
  - **1** useless or actively misleading
- Grade the answer's usefulness to you, not the model's reputation, and not how long it took.
- Only a run that produced an answer can be graded, and Baton refuses the rest. A crashed CLI, a timeout or an unparseable answer is not a 1 — those are recorded against the execution target as reliability by itself, so there is nothing for you to report on them.
- `notes` is one line on *why* — that is what makes a grade re-readable later.
- Reports are upserts: re-reporting the same `run_id` replaces its grade, so a correction never double-counts.
- From the shell: `baton grade <run_id> <1-5> [notes...]`, and `baton ratings` prints the current table (observed, prior, blended, and which profile the prior came from).
- Blind duels (`run_duel` / `report_duel`) are not available yet — they land in phase 3.

### Onboarding: seeding the user's priors

Before there is local evidence, ratings are whatever the user already believes. Once, at setup — or whenever the user wants to revise their opinion of the models — interview them and submit the result with `seed_ratings(profile_name, entries)`:

1. Ask for **comparisons, not numbers**: "who do you trust for a review?", "is kimi-k3 about as good as opus-5 for implementation?", "which one would you never hand a migration to?". Ordinal and pairwise statements are what people are actually calibrated on; invented 1–5 scores are not.
2. **Split multi-axis prose.** "Fast but sloppy" is two claims. Speed is routing metadata, not a quality prior — only the quality claim becomes a seeded rating. Same for cost.
3. Map each claim to an entry: `{ model, category?, mean, weight? }` — canonical model ids only (`kimi-k3`, never `kimi:default/kimi-code/k3`), `mean` on the 1–5 grade scale, `category` omitted for a general opinion.
4. **Echo the normalized entries back and get an explicit yes** before calling `seed_ratings`. You propose, the user approves — a seed they did not recognise is a seed that quietly misroutes work.
5. Seed weight is capped at the worth of ~5–10 observations on purpose: a wrong seed fades as real grades arrive instead of steering routing for months.

Ask about **preciousness** in the same conversation — how freely each account may be spent — and set it from the shell, where the trusted config lives: `baton set preciousness:<app>:<instance> burn|conserve|emergency`.
