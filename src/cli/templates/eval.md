### Optional ratings and comparisons

Baton works without ratings or a setup interview. After using an answer, `report_result(run_id, grade, notes?)` can record its usefulness on a 1–5 scale. Grade the answer, not the model's reputation or execution speed. A failure without an answer is already tracked as execution reliability. Re-reporting replaces the earlier grade.

Use `run_duel([a, b], prompt)` for a blind comparison of two models, then `report_duel(duel_id, "A" | "B" | "tie")` after judging the answers. Duels share a directory and must be non-mutating.

If the user requests model preferences, `seed_ratings(profile_name, entries)` records them. Use canonical model IDs and distinguish quality from speed or cost. No extra confirmation is needed for an explicitly requested preference change. `baton profile import` imports a shared profile; `--dry-run` previews it. The first profile activates automatically.

`baton ratings` shows the evidence. `baton ratings export` writes a snapshot when needed. Account pools, spending preferences and shared profiles are optional configuration.
