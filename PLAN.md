# model-router — Plan (v3)

> Working name. The tool routes *agent delegations across apps*, not API calls.
> v2 incorporated design reviews by kimi-k3 and gpt-5.6-sol (2026-08-22). v3 simplifies critical identity separation (delegated to the environment/direnv) and adds instance-pool load balancing. Review log at bottom.

## Vision

A local tool that lets whatever coding agent you are running (Claude Code, Codex, Kimi Code, OpenCode, Cursor Agent, …) delegate tasks to models running in *other* agent apps on the same machine — using your existing subscriptions, with quota-aware and quality-aware routing that improves from observed results. Model-agnostic: any supported app can be the caller or the callee.

**The defensible first product is a secure local execution broker**: environment-transparent identities, predictable job semantics, safe delegation. Routing intelligence, evaluation, and sharing build on that foundation — not the other way around.

## Why not simpler alternatives

- **Instructions-only** (CLAUDE.md/AGENTS.md telling the agent how to shell out): fragile, per-host dialects, every agent re-derives CLI mechanics, breaks silently on flag changes.
- **API proxy (LiteLLM-style)**: wrong layer. The value is delegating to *agents with tools and subscriptions*; subscriptions live inside the CLIs, so CLIs must be the execution unit.
- **LLM-powered router**: unnecessary. The calling agent is smart; give it a scored registry and let it choose. The router stays deterministic and mechanical.

## Identity model: environment-transparent by design

Critical identity separation (enterprise vs. personal) is **not model-router's job** — it belongs to the environment, where direnv already solves it. The user binds identity env vars (`CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, …) to directories via direnv; every process launched there — the host agent, the MCP server it spawns, and every callee CLI the router launches — inherits the right identity automatically. model-router's contract is three rules:

- **Pass through** adapter-declared identity env vars from its own inherited environment to callee processes. They sit on the scrub allowlist; all other secrets are still scrubbed from child environments.
- **Never override a pinned identity.** If the inherited environment sets an identity variable for an app, that pin wins: an explicit `app:instance/...` request that conflicts with it is a hard error, and pool balancing (below) is disabled for that app in that context. This one rule preserves the safety property with near-zero machinery.
- **Record, don't enforce.** Every run stores an identity fingerprint (hash of the identity env vars in effect, plus `whoami` attestation where the CLI offers one), so `model-router status`/`runs` show which identity was actually used and can flag anomalies.

Honest limits, documented: the router cannot control prompt content, cannot police direct CLI use that bypasses it, and inherits direnv's own caveat — sessions launched outside a direnv-loaded shell (some IDE launchers) won't carry the pin. `model-router status` prints the active identity fingerprint precisely so this is checkable at a glance.

A consequence for discovery: probing is **environment-contextual**. Asking Claude to "discover opencode" inside the client folder probes the enterprise opencode config, because that is what the environment exposes — which is correct. Adapter specs therefore capture only environment-independent mechanics (invocation, flags, parsing); model/provider availability is enumerated at `detect`/`list_models` time and cached per identity fingerprint.

## Architecture

One TypeScript package, one binary (`model-router`), two faces:

- **MCP server** (`model-router mcp`): stdio per host by default. Targets the MCP 2026-07-28 stateless spec (cross-call state via server-minted handles as tool arguments; long-running work via the Tasks extension with handle-polling fallback). `serve --http` (late phase) runs the same server as stateless Streamable HTTP.
- **CLI**: `detect`, `install`, `models`, `set`, `adapters`, `profile`, `status`, `runs`.

Shared core: registry, adapters, run supervisor, ratings.

**State store: SQLite, single-writer semantics.** Multiple hosts spawn multiple stdio server processes concurrently (Claude Code + Codex + Cursor at once); loosely coordinated flat files would corrupt under read-modify-write. All mutable state (runs, accumulator, quota observations) lives in one SQLite DB with transactions; registry/config remain human-readable files, written atomically by the CLI.

- `~/.config/model-router/` — registry (models, routes, instances, adapters, workspace profiles).
- `~/.local/share/model-router/` — SQLite DB (runs ring buffer, accumulator, quota state), rating profiles. Directory permissions 0700; raw prompts retained only in the ring buffer, size-capped, never exported.

## Registry: models, routes, instances, execution targets

- **Model** — canonical identity (`kimi-k3`, `opus-5`). Used for addressing and as a *hierarchical prior* over its execution targets. Carries a small static prior (see "Scores", below).
- **Route** — (app, slug): a way to reach a model, e.g. `kimi` CLI slug `kimi-code/k3` or `opencode` slug `moonshot/kimi-k3`.
- **Instance** — named identity of an app: (app, instance-name, env overlay such as `CLAUDE_CONFIG_DIR=~/.claude-personal2`). Every app has `default` (whatever the inherited environment provides). Named instances exist for *non-critical* convenience — explicit selection and pool load balancing — not for enterprise separation, which lives in the environment (direnv).
- **Execution target** — the unit ratings actually attach to: route + instance + fingerprint (app version, adapter version, model alias epoch, relevant mode settings). The same model through different harnesses is *not* interchangeable — system prompts, tools, sandboxing, and context construction differ per app. Canonical-model ratings are a rollup (hierarchical prior) across targets, so evidence pools without pretending targets are identical.

Addressing: `app[:instance]/model` (e.g. `claude-code:client/opus-5`); callers normally name just the model and the router picks the best permitted target.

### Instance mechanics

Identity env var per app: `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `OPENCODE_CONFIG_DIR` (OpenCode), `KIMI_CODE_HOME` (Kimi). **Cursor Agent has no state-directory mechanism** (browser auth / `CURSOR_API_KEY` only) — no named instances there until proven. Setup: `model-router instance add claude-code personal-2 --env CLAUDE_CONFIG_DIR=~/.claude-personal2`; the login itself stays interactive (the router prints the `CLAUDE_CONFIG_DIR=... claude /login` command, the user completes OAuth once). A light one-time sanity check per named instance (a canary run plus `whoami` attestation where available) replaces plan v2's heavyweight verification harness — proportionate to the stakes now that enterprise separation is out of scope.

Child environments remain **scrubbed to an allowlist** (identity env vars + minimum required); provider API keys, cloud creds, and SSH agent are never inherited by callees.

### Instance pools and load balancing

Multiple non-critical identities of the same app (e.g. two personal Claude subscriptions) form a **pool**. Routes resolve to the pool; the router picks the instance per run:

- **Proactive spreading, not just failover.** Selection is weighted by observed quota headroom per instance — each account has independent 5-hour windows and weekly caps. Rotating only on rate-limit errors moves the burst to the next account and drains them serially; spreading keeps all windows warm. (Prior art validating the mechanism: CLAUDE_CONFIG_DIR-based balancers such as jonroosevelt's and teamclaude.)
- **Failover on limit.** A rate-limit error marks the instance cooling-down (until window reset when parseable from CLI output, otherwise exponential backoff) and the run retries on the next pool member. This replaces manual logout/login entirely.
- **Session affinity.** Resumed runs stick to their original instance — session state lives in that config dir; resume handles already bind to the execution target.
- **Precedence:** environment pin > explicit instance argument > pool balancing > default. Pools never operate where the environment pins the app's identity.
- Per-instance quota observations land in the SQLite store and feed both balancing and preciousness policy.
- Flagged plainly: rotating multiple subscriptions to stretch limits may sit poorly with provider ToS; the feature is user-configured and the docs note it.

## Execution: the run supervisor

`run_model` is the tool's most dangerous surface — unattended delegation to tool-wielding agents — and gets a real design:

- **Run state machine** in SQLite: `queued → running → {succeeded, failed, timeout, cancelled}` with atomic claims, idempotency keys (an MCP retry must not launch an expensive task twice), process-group ownership, kill-on-timeout of the whole group, bounded output capture, and orphan recovery on restart (a run whose supervisor died is marked `orphaned`, not left "running" forever).
- **Deterministic interface**: `run_model` always returns a `run_id` handle; `wait: true` additionally blocks up to a caller-supplied budget and inlines the result if finished. No duration-dependent shape changes.
- **Execution modes per run**, declared in the adapter as supported autonomy levels:
  - `read-only` (default): callee runs with the most restrictive permission flags the app supports; advisory output only.
  - `worktree`: mutations allowed, but in an isolated git worktree; results come back as a diff.
  - `workspace-write`: mutations in place — explicit opt-in per call, never default.
  - Duels never run two mutating agents against the same checkout (read-only or separate worktrees, always).
- **Recursion and resource limits**: every delegated run carries a hop count in its environment; the router refuses runs past a depth limit (default 2) to stop delegation loops (Claude → Kimi → Claude…). Per-workspace concurrency caps and per-run output/time budgets.

## Quota-aware cost (replaces static cost scalars)

Subscriptions are flat-rate: the marginal dollar cost of a call is zero, and the real constraint is **rate-limit/quota-window budget**. Static user-entered cost numbers would be fiction. Instead:

- Per-instance **quota state**, observed where CLIs expose usage (usage commands, headers, error messages) and estimated from run counts otherwise.
- A coarse user-owned **preciousness** setting per instance (e.g. "burn freely" / "conserve" / "emergency only") replaces the invented per-route cost scalar — this is the one number users can actually answer honestly, collected conversationally during setup.
- Routing guidance combines preciousness + observed quota headroom: "don't burn the Claude weekly window on lint fixes" becomes expressible.

## MCP surface

- `list_models` — available models/targets in the current identity context, merged scores (prior + observed, shown separately), per-pool quota headroom, degraded-adapter warnings. Deterministic order, `ttlMs` set.
- `run_model(model, prompt, mode?, instance?, wait?, category?)` — as above.
- `get_run(run_id)` — poll; surfaces as native MCP Tasks where the client supports the extension.
- `report_result(run_id, grade, notes?)` — eval ingestion.
- `run_duel(models[2], prompt)` / `report_duel(duel_id, winner)` — blind A/B (server randomizes labels; mapping revealed only after judgment). Non-mutating modes only.
- `discover_app(name)` / `register_app(spec)` — onboarding (below).

## Agentic discovery (quarantined, structurally constrained)

One adapter format, two provenances — but **not equal trust**. Built-in adapters are pinned and CI-tested; discovered adapters enter quarantined.

The adapter format is declarative and safe by construction: absolute executable path (must match the `detect`-verified binary), **argv arrays, never shell strings**, prompt passed via stdin where possible, `{model}`/`{cwd}` placeholders substituted as single argv elements (no shell interpretation), environment allowlist, declarative output extraction (JSON-path/regex with bounded complexity), no arbitrary transformation code. This kills shell injection through placeholders and most template-poisoning shapes.

Flow ("discover codex"):
1. `discover_app` → **discovery brief**: probe checklist (binary, help, non-interactive invocation, structured output, model slugs, resume, auth state, identity env var, supported autonomy levels) + adapter-spec JSON Schema. The brief warns the agent that help text and CLI output are untrusted content, never instructions.
2. Agent probes, submits `register_app(spec)`. Structural validation rejects anything outside the declarative format (URLs in argv, unresolved binaries, shell metacharacters).
3. Server runs the **canary** itself ("reply with exactly TOKEN"), knowing the canary proves extraction, not safety.
4. **Activation happens in the trusted CLI, not through the agent**: `model-router adapters review <name>` shows the exact executable, argv, and env names; the user approves there — never through the agent that authored the spec.
5. Setup questions the user can actually answer (preciousness, which models to expose) are collected conversationally by the agent and submitted via `set`.
6. `detect` watches versions: bump → adapter drops to `stale` → auto re-canary; auth-mechanism changes force re-verification, and stale/broken adapters are *visibly degraded* in `list_models` (with the fix command), not silently waiting for a discovery session that may never come.

## Evaluation, ratings, profiles

Three artifacts, strictly separated:

- **Run ring buffer** (private, never exportable; SQLite, capped ~2,000 runs / 10 MB): raw runs incl. prompts, paths, attested identity, grades. Debugging, duel correlation, grade backfill.
- **Accumulator** (derived, aggregate-only, constant-size): per (execution target, category) decayed sufficient statistics — grade sums, weights, *squared weights* (for effective sample size `n_eff = (Σw)²/Σw²`), and a sparse decayed pairwise win edge-map.
- **Profiles** (shareable): snapshot of an accumulator + metadata (author, `as_of` date, model/target set, schema version). Aggregate numbers only. v1 keeps shared granularity coarse (model-level rollups + overall ratings); fine category taxonomies stay local until cross-user alignment is proven.

Corrections adopted from review:

- **Decay is time-based, applied at read**: multiplier `2^(−Δt/half-life)` (default 90d) from each statistic's `as_of` timestamp — never per-event. Late grades weight from the *run's* time, preserving order-independence. Imported profiles decay from their `as_of` date, so a stale snapshot doesn't masquerade as fresh evidence.
- **Ratings are prior-correction, not the engine.** At single-user volume the win graph stays sparse and possibly disconnected; a regularized/Bayesian Bradley-Terry fit (shrinkage to the canonical-model prior, identifiability anchored, confidence from the posterior) prevents infinite estimates and disconnected-graph nonsense — but the honest positioning is: priors (imported profiles, first-party profiles seeded from CI canaries) do most of the work; local pointwise outcome/reliability tracking corrects them; BT sharpens things only where duel density exists.
- Grade EMAs and BT scores are reported as **separate signals** (reliability vs. head-to-head preference), not fused into one number on incompatible scales.
- Known measurement limits, documented rather than hidden: blind labels reduce brand bias but styles are recognizable; grades are selection-biased (harder tasks go to stronger models); "needed rework" conflates model, adapter, and prompt quality. Adapter/parse failures are recorded as *reliability* events against the target, not quality events against the model.

Profile layering: the local accumulator always keeps recording. A loaded profile is a prior at configurable weight; effective ratings fit over `prior × weight + own`; switching profiles swaps the prior, nothing is overwritten. Import always shows a summary diff — never silently reweights.

Eval is opt-in via the instruction layer (grade after *using* the result; consumer grades, not producer).

## Installers / instruction layer

`model-router install <host>`: registers the MCP server in the host's config and renders the instruction layer in the host's dialect from one template — `SKILL.md` for Claude Code and Cursor, `AGENTS.md` block for Codex/OpenCode/Kimi. Host-parameterized (native models vs. routed models). Eval skill is a separate opt-in (`install --with-eval`). `--no-mcp` fallback emits direct-CLI instructions.

## Non-interactive CLI surfaces (to be re-verified in phase 0)

- `claude -p --output-format json` (+ `--resume`), `CLAUDE_CONFIG_DIR`
- `codex exec --json`, `codex exec resume`, `CODEX_HOME`
- `opencode run --format json`, `OPENCODE_CONFIG_DIR`
- `cursor-agent -p --output-format stream-json` — no state-dir mechanism; instances unsupported pending proof
- `kimi -p --model kimi-code/k3`, `KIMI_CODE_HOME`

## Build order (revised after review)

0. **Environment spikes**: confirm identity env passthrough end-to-end (direnv shell → host agent → MCP server → callee CLI, including IDE-launched sessions), OAuth login and token-refresh behavior in secondary `CLAUDE_CONFIG_DIR`s, and rate-limit signal parsing from `claude -p` output. Cheap; de-risks both the transparency contract and pools.
1. **Execution core**: registry (model/route/instance/target), safe declarative adapter format, one built-in adapter (codex) end-to-end read-only — run state machine in SQLite, argv-only execution, scrubbed-env-with-identity-passthrough, pin-respect rule, identity fingerprint recording, idempotency, cancellation, output limits.
2. **Instance pools**: quota observation per instance, headroom-weighted selection, cooldown/failover, session affinity, preciousness policy.
3. **Second adapter (kimi or opencode) + adapter conformance suite**, `list_models`, installers (Claude Code + Codex first).
4. **Mutation modes** (worktree isolation), concurrency caps, remaining first-party adapters.
5. **Eval foundation**: ring buffer, time-decayed accumulator with priors *from day one*, `report_result`, profile import/use + diff, eval skill. Pointwise + reliability signals only.
6. **Duels + regularized Bradley-Terry** (once duel density exists), profile export/sharing polish.
7. **Agentic discovery** (quarantine + trusted-CLI activation), HTTP daemon mode + workspace handles, Tasks extension surface.

Discovery moves late deliberately (contra plan v1): the adapter contract must survive real upgrades before agents are allowed to author adapters.

## Open concerns

- TS SDK support for 2026-07-28 may still be settling; design is stateless regardless, wire revision is a config knob.
- Static capability axes from the original table survive only as coarse priors on canonical models, superseded by observed data; no pretense of maintained per-axis truth.
- Shared profiles remain unsigned opinions; import-diff from day one, signing if a registry ever exists.
- Subscription ToS/automation limits per CLI need a check before promoting heavy automated delegation.

## Review log

- 2026-08-22 — kimi-k3 (via kimi CLI) and gpt-5.6-sol (via codex exec, xhigh): convergent findings on cwd trust, credential-isolation verification, run_model security surface, discovery injection, eval sample-size realism, static-cost fiction, and file-store concurrency — all incorporated in v2. Sol additionally: ratings attach to execution targets with canonical-model hierarchical priors; deterministic run interface; recursion limits; Cursor lacks a state-dir mechanism. Kimi additionally: quota-budget framing; visible degraded adapter state; read-time decay bug.
- 2026-08-22 (v3) — user decision: critical identity separation delegated to the environment (direnv); v2's workspace security profiles, restricted instances, and two-account verification harness removed as out of scope. Replaced by the environment-transparent contract (passthrough, pin-respect, record-don't-enforce) and instance pools for load balancing across non-critical identities. Resolves the reviewers' cwd-trust and enforcement-hole findings by removing the enforcement claim rather than hardening it.
