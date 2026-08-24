# Baton — Plan (v6)

> **Baton** — as in the thing you pass in a relay race: work handed from one agent to the next.
> v2 incorporated design reviews by kimi-k3 and gpt-5.6-sol (2026-08-22). v3 delegated critical identity separation to the environment (direnv) and added instance pools. v4: renamed Baton, Bun toolchain, derived ratings file, seeded priors, caller-owned permissions, 3-phase build. v5 incorporated the second review round. v6: identity machinery removed entirely — Baton is fully environment-transparent, and scope separation comes from `BATON_CONFIG_DIR` partitioning instead of runtime checks. Review log at bottom.

## Vision

A local tool that lets whatever coding agent you are running (Claude Code, Codex, Kimi Code, OpenCode, Cursor Agent, …) delegate tasks to models running in *other* agent apps on the same machine — using your existing subscriptions, with quota-aware and quality-aware routing that improves from observed results. Model-agnostic: any supported app can be the caller or the callee.

Design stance: **reactive, composable, as simple as possible.** Baton behaves like a careful shell user, not a policy engine: it runs the CLI the caller asks for, in the environment it inherited, and observes what happens. No explicit state tracking that the environment or the filesystem can provide implicitly.

## Why not simpler alternatives

- **Instructions-only** (CLAUDE.md/AGENTS.md telling the agent how to shell out): fragile, per-host dialects, every agent re-derives CLI mechanics, breaks silently on flag changes. Baton's own development starts from exactly this setup and dogfoods its way out of it (see build phases).
- **API proxy (LiteLLM-style)**: wrong layer. The value is delegating to *agents with tools and subscriptions*; subscriptions live inside the CLIs, so CLIs must be the execution unit.
- **LLM-powered router**: unnecessary. The calling agent is smart; give it a scored registry and a deterministic selection policy. Baton stays mechanical.

## Identity: fully delegated to the environment

Baton does not track, verify, or enforce identity. When `run_model` is called, Baton executes the callee CLI with the environment it inherited — whatever identity the environment supplies (via direnv-set vars like `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`) is what runs, exactly as if the user had typed the command in that shell. Enterprise opencode calling a Claude model from within an enterprise direnv scope gets enterprise Claude automatically, because the environment says so. This is confirmed working in practice: Claude's credentials (including Keychain-backed auth on macOS) follow `CLAUDE_CONFIG_DIR`, and enterprise + personal Claude sessions run simultaneously today under direnv.

**Scope separation is achieved by state partitioning, not runtime checks.** `BATON_CONFIG_DIR` is Baton's own identity-style env var, set by direnv alongside the agent apps' vars. It relocates Baton's entire world — registry, instances, pools, quota state, ratings, preciousness, the SQLite DB. The enterprise scope points at a Baton config that defines only enterprise-appropriate instances and accumulates its own quota and ratings; the personal scope has another. Cross-scope leakage is structurally impossible: a scope cannot route to instances it has no definition of, and its observations land in its own database. No pin states, no fingerprints, no attestation, no enforcement — the same composable mechanism that separates the agent apps separates Baton.

Callee environment = Baton's inherited environment + an instance's env overlay when pool balancing selects one + `BATON_HOPS`. Nothing is scrubbed or allowlisted; Baton is not more special than a shell.

Honest limits, documented: Baton verifies nothing about identity — environment correctness is the user's responsibility, exactly as it is when running the CLIs by hand. `baton status` prints the currently resolved identity env vars and active `BATON_CONFIG_DIR` as a live convenience read (no stored state). Delegations that bypass Baton also bypass its hop counting.

A consequence for discovery: probing is **environment-contextual**. Asking Claude to "discover opencode" inside the client folder probes the enterprise opencode config, which is correct — and the resulting adapter mechanics are environment-independent, while model availability is enumerated per scope at `detect`/`list_models` time.

## Architecture

One TypeScript package, one binary (`baton`), two faces:

- **MCP server** (`baton mcp`): stdio per host by default. Built on the TypeScript SDK v2 (`@modelcontextprotocol/server` 2.0.0 — the monolithic `@modelcontextprotocol/sdk` stayed at 1.x; v2 lives in split packages). v2 implements the 2026-07-28 stateless core (`server/discover`) and still negotiates the legacy `initialize` handshake down to 2024-era clients, so current hosts (Claude Code, protocol `2025-11-25`) work unchanged. Baton keeps the stateless discipline at its own layer regardless: cross-call state travels as server-minted handles (`run_id`) in tool arguments; long-running work via handle polling, upgrading to the Tasks extension when host support lands. `baton serve --http` (phase 3) runs the same server as stateless Streamable HTTP — one daemon per environment scope, since a daemon inherits one environment.
- **CLI**: `detect`, `install`, `models`, `set`, `adapters`, `instance`, `profile`, `ratings`, `status`, `runs`.

**Toolchain: Bun for everything** — runtime, package manager, test runner, scripts, packaging. `bun:sqlite` is the native SQLite driver. Distribution: `bun build --compile` single-file executables per platform plus an npm wrapper package for npx/bunx users. Phase 1 includes a compiled-binary smoke test: external SQLite file, child-process spawning, signal handling, packaged templates.

**State store: SQLite (`bun:sqlite`) is the source of truth for everything mutable** — runs, attempts, quota observations, the rating accumulator, priors, and registry records that MCP tools can mutate (discovered adapters, instances, seeded profiles). WAL mode, `busy_timeout`, retry-on-`SQLITE_BUSY`; serialized schema migrations. Static user config stays in human-readable files written atomically by the CLI. Default locations are XDG (`~/.config/baton/`, `~/.local/share/baton/`); when `BATON_CONFIG_DIR` is set, both config and state live under it — that single override is what makes scope partitioning work. Data-dir permissions 0700; raw prompts live only in the capped ring buffer and are never exported.

## Registry: models, routes, instances, execution targets

- **Model** — canonical identity (`kimi-k3`, `opus-5`). Used for addressing and as a *hierarchical prior* over its execution targets.
- **Route** — (app, slug): a way to reach a model, e.g. `kimi` CLI slug `kimi-code/k3` or `opencode` slug `moonshot/kimi-k3`.
- **Instance** — named env overlay for an app (`claude-code:personal-2` → `CLAUDE_CONFIG_DIR=~/.claude-personal2`). Every app has `default` (no overlay — the inherited environment as-is). Instances exist for exactly two purposes: explicit selection and pool load balancing. They are not a separation mechanism.
- **Execution target** — the unit ratings attach to: route + instance + fingerprint (app version, adapter version, model alias epoch, resolved permission policy, relevant mode settings). The same model through different harnesses — or at different autonomy levels — is not interchangeable; the fingerprint keeps their evidence separate. Canonical-model ratings are a rollup (hierarchical prior) across targets.

Addressing: `app[:instance]/model`; callers normally name just the model.

**Target selection is a versioned, deterministic policy**: filter by availability and authority ceiling → rank by quota headroom weighted by preciousness → then by rating → stable tie-break (target id). The policy version is recorded per run; callers can bypass it with an explicit target.

### Instance mechanics

Setup: `baton instance add claude-code personal-2 --env CLAUDE_CONFIG_DIR=~/.claude-personal2`; login stays interactive (Baton prints the command, the user completes OAuth once), followed by an optional canary run as a sanity check. Instance definitions live in the active `BATON_CONFIG_DIR`, so each scope only knows the instances its config defines. **Cursor Agent and OpenCode are excluded from instances and pools**: Cursor's only identity mechanism is an API key, and OpenCode's credential store follows neither a config-dir var nor `HOME` (phase-2 probe) — no env-overlay mechanism, no support, revisit if that changes.

### Instance pools and load balancing

Multiple identities of the same app (e.g. two personal Claude subscriptions) form a **pool**. Pool membership is user-defined config — Baton trusts it, as it trusts the rest of the environment. Per run:

- **Proactive spreading, not just failover.** Selection weighted by observed quota headroom per instance (independent 5-hour windows and weekly caps per account). Rotating only on errors drains accounts serially; spreading keeps all windows warm.
- **Failover on admission failure only.** A rate-limit or auth error *before the callee starts work* marks the instance cooling-down (until window reset when parseable, else exponential backoff) and the attempt retries on the next member. If the callee may already have produced side effects, Baton does not silently replay — the run fails with a resumable state and the caller decides.
- **Session affinity.** Resumed runs stick to their original instance (session state lives in that config dir).
- **Precedence:** explicit instance argument > pool balancing > default. Scope appropriateness is already guaranteed by partitioning — a scope's config defines only the instances that belong there.
- Quota observations are per instance within the active scope's own DB.
- **Gate before build:** the provider-ToS check on multi-account rotation is an entry gate for this feature in phase 2, not a someday concern.

## Execution: runs, attempts, and the authority ceiling

- **Logical run → attempts.** A run is the caller's request; each execution (instance, process, output, reliability outcome) is an attempt. Failover creates a new attempt under the same run; reliability events attribute to the attempt's target, quality grades to the attempt that produced the answer. State machine per attempt (`queued → running → {succeeded, failed, timeout, cancelled, orphaned}`) with atomic claims, process-group ownership, kill-on-timeout of the whole group, bounded output capture. Orphan recovery verifies the process group is actually dead before marking `orphaned`.
- **Idempotency is caller-visible.** `run_model` accepts an `idempotency_key` (payload-bound): an MCP retry with the same key returns the existing run instead of double-launching; a deliberate repeat uses a new key. `report_result`/`report_duel` are upserts, so retried reports can't inflate grades.
- **Deterministic interface**: `run_model` always returns a `run_id`; `wait: true` additionally blocks up to a caller budget and inlines the result if finished.
- **Authority ceiling (user-owned), permission choice (caller-owned).** Baton doesn't manage sandboxes or modes — each adapter declares the app's permission flags and a full-autonomy default, and callers override per call via adapter-validated `options`. But a per-app/target `max_autonomy` ceiling, set only through the trusted CLI/installer config (never through a tool call), clamps what callers can request: options may narrow the ceiling, never raise it. The resolved policy enters the execution-target fingerprint. `cwd` defaults to the inherited host cwd; pointing a delegated agent elsewhere is allowed and documented as a deliberate capability.
- **Recursion and resource limits**: `BATON_HOPS` is injected into every callee environment; runs past the depth limit (default 2) are refused, stopping delegation loops. Per-scope concurrency caps and per-run output/time budgets. Documented caveat instead of machinery: concurrent delegated agents mutating the same checkout can conflict — callers decide; duels run both sides with identical options and cwd and are best given non-mutating tasks.

## Quota-aware cost

Subscriptions are flat-rate; the real constraint is **rate-limit/quota-window budget**, not invented per-route cost numbers:

- Per-instance quota state, observed where CLIs expose usage and estimated from run counts otherwise — accumulated per scope, so enterprise and personal economics never mix by construction.
- A coarse user-owned **preciousness** setting per instance ("burn freely" / "conserve" / "emergency only"), collected conversationally during onboarding. Different scopes can rate the same app differently (enterprise tokens: "emergency only" in the personal scope's config simply doesn't exist — that scope has no such instance).
- The selection policy combines preciousness with observed headroom: "don't burn the Claude weekly window on lint fixes" becomes expressible.

## MCP surface

- `list_models` — available models/targets in this scope, merged scores (prior + observed, shown separately), per-pool quota headroom, degraded-adapter warnings. Deterministic order, `ttlMs` set.
- `run_model(model, prompt, cwd?, instance?, wait?, category?, options?, idempotency_key?)`
- `get_run(run_id)` — poll; surfaces as native MCP Tasks where the client supports the extension.
- `report_result(run_id, grade, notes?)` — upsert.
- `run_duel(models[2], prompt, options?)` / `report_duel(duel_id, winner)` — blind A/B under the same permission contract as `run_model`; labels randomized, mapping revealed after judgment.
- `seed_ratings(profile_name, entries[])` / `get_ratings()` — seeded priors and current ratings.
- `discover_app(name)` / `register_app(spec)` — onboarding of new apps.

## Agentic discovery (quarantined; approval before execution)

One adapter format, two provenances — but not equal trust. Built-in adapters are pinned and CI-tested; discovered adapters enter quarantined.

The adapter format is declarative and safe by construction: absolute executable path (must match the `detect`-verified binary), **argv arrays, never shell strings**, prompt via stdin where possible, placeholders substituted as single argv elements, declarative bounded output extraction, no arbitrary code.

Flow ("discover codex"):
1. `discover_app` → **discovery brief**: probe checklist (binary, help, non-interactive invocation, structured output, model slugs, resume, auth state, identity env var, permission flags) + adapter-spec JSON Schema. The agent probes by running the target CLI itself; the brief notes that help text and CLI output are untrusted content.
2. Agent submits `register_app(spec)`; structural validation rejects anything outside the declarative format. The spec is stored **quarantined — Baton executes nothing from it yet.**
3. **Approval precedes execution.** `baton adapters review <name>` in the trusted CLI shows the exact executable, argv, and env names; only after the user approves does Baton run its canary ("reply with exactly TOKEN") to verify extraction, then activate. Re-canary after a version bump re-runs the already-approved spec; a changed spec goes back through review.
4. Setup questions (preciousness, models to expose, seeded ratings) are collected conversationally and submitted via `set`/`seed_ratings`.
5. `detect` watches versions: bump → `stale` → re-canary; stale/broken adapters are visibly degraded in `list_models` with the fix command.

## Evaluation, ratings, profiles

Storage roles, strictly separated — all in SQLite (per scope):

- **Run ring buffer** (private, never exportable; capped ~2,000 runs / 10 MB): raw runs/attempts incl. prompts and grades.
- **Accumulator** (observed evidence only): per (execution target, category) decayed statistics — grade sums, Σw, Σw² (for `n_eff = (Σw)²/Σw²`), sparse pairwise win edge-map with per-edge `as_of`.
- **Priors table** (explicit, provenance-tagged): seeded and imported priors — canonical model/category, prior mean, bounded precision, source, `as_of`. Never mixed into the accumulator; `list_models` shows "prior" and "observed" separately, and regeneration merges both.
- **`ratings.yaml`** (derived, display/share only): human-readable projection in the active config dir. Header states it is GENERATED — edit via `seed_ratings`/`baton profile`, hand-edits are overwritten. **Baton never reads this file back**; routing reads SQLite.

**Publication protocol** (fixes the stale-write race, not just the torn-write one): every outcome commit increments a monotonic revision in the same transaction. The publisher takes a publication lock, reads state after acquiring it, renders with `source_revision` embedded, and atomically renames only over an older revision; stale renders are discarded and retried. Startup repairs a stale projection.

### Decay: the exact rule

Write-side decay-forward, so constant-size aggregates stay correct for mixed-age evidence: on each event at time `now` for a run that happened at `t_run`, first decay the aggregate from its `as_of` to `now` by `2^(−Δt/half-life)` (default 90d; Σw² decays by the square), then add the event with weight `2^(−(now − t_run)/half-life)` (late grades weight from the run's time), then set `as_of = now`. Read-side, a residual decay from `as_of` to read time applies as a common factor — it matters when blending against priors, whose own precision decays from *their* `as_of`. Same rule per edge on the BT map.

### Seeded priors (onboarding)

The user tells their agent how they rate the models they know; the agent maps that to `seed_ratings` entries:

- Collected as **ordinal/pairwise statements** where possible ("kimi-k3 ≈ opus-5 for implementation" becomes a BT prior edge / anchored rating); multi-axis prose is split (speed ≠ quality; speed feeds routing metadata, not the quality prior).
- The normalized entries are **echoed back for confirmation** before commit — the interviewing agent proposes, the user approves.
- Precision is **capped** (equivalent of ~5–10 observations) so a wrong seed can't steer routing for months at single-user grade rates.
- Seeds attach at the **canonical-model level** and flow to targets through the hierarchical prior — never copied into per-target evidence.
- Sparse is fine: unrated models surface as "unrated" until evidence arrives. The user's existing CLAUDE.md rankings become the first seeded profile.

### Layering and sharing

The local accumulator always keeps recording. A loaded profile (imported or seeded) is a prior at configurable weight; effective ratings fit over `prior × weight + own`; switching profiles swaps the prior, nothing is overwritten; import shows a summary diff, never silently reweights. **Exports are portable by construction**: `baton profile export` emits canonical model/category priors only — local target fingerprints, instances, and machine details stay in the private view. Rating math: regularized/Bayesian Bradley-Terry (shrinkage to the canonical prior, identifiability anchored, confidence from the posterior) where duel density exists; grade EMAs and BT reported as separate signals; adapter/parse failures recorded as *reliability* against the target, not quality against the model. Honest positioning: priors do most of the work at single-user volume; local evidence corrects them.

Eval is opt-in via the instruction layer (grade after *using* the result; consumer grades, not producer).

## Installers / instruction layer

`baton install <host>`: registers the MCP server in the host's config and renders the instruction layer in the host's dialect — `SKILL.md` for Claude Code and Cursor, `AGENTS.md` block for Codex/OpenCode/Kimi. Host-parameterized. Eval skill is opt-in (`install --with-eval`); the onboarding interview (preciousness + seeded ratings) is part of the phase-2 install flow — phase 1's installer is registration + instructions only. `--no-mcp` fallback emits direct-CLI instructions.

## Non-interactive CLI surfaces (verify in phase-1 spikes)

- `claude -p --output-format json` (+ `--resume`), `CLAUDE_CONFIG_DIR` — multi-config confirmed working (incl. Keychain) by real-world use
- `codex exec --json`, `codex exec resume`, `CODEX_HOME`
- `opencode run --format json` — **no identity env var** (phase-2 probe: `OPENCODE_CONFIG_DIR` does not exist, and neither `XDG_*` nor `HOME` relocates `~/.local/share/opencode/auth.json`), so opencode has only the inherited-environment `default` instance and no pool is possible, same as cursor-agent
- `kimi -p --model kimi-code/k3`, `KIMI_CODE_HOME`
- `cursor-agent -p --output-format stream-json` — adapter yes (phase 3), instances no

## Build phases (3, dogfood-first)

**Phase 1 — Dogfood vertical slice: one host, two callees, real broker semantics.**
Bun scaffold + compiled-binary smoke test; SQLite store (WAL, busy handling, migrations) with `BATON_CONFIG_DIR` partitioning; registry; declarative adapter format with **codex and kimi** built-in adapters; run supervisor (runs/attempts, idempotency keys, hop limits, ceiling config); `list_models`/`run_model`/`get_run` over stdio MCP; `baton install claude-code` (registration + instructions). Spikes first: rate-limit signal parsing per CLI; `BATON_CONFIG_DIR` partitioning smoke (two scopes, two DBs, no bleed).
*Exit criterion (testable): Baton replaces the global CLAUDE.md model-routing instructions for this repo's development — a real task delegated to each adapter through Baton, a retried `run_model` deduplicated by its idempotency key, a timeout killed and cleaned up, and two scopes shown fully partitioned.*

**Phase 2 — Pools, quota, ratings foundation.**
Entry gate: provider-ToS check on multi-account rotation. Instance pools (headroom-weighted selection, admission-failure-only failover, session affinity); quota observation + preciousness; opencode + claude-code callee adapters; eval foundation (ring buffer, accumulator with the specified decay rule, priors table, `report_result`, publication protocol for `ratings.yaml`, seeded-prior onboarding interview, profile import/use with decayed `as_of` and import diff); eval skill; remaining installers.
*Exit criterion: Baton load-balances the personal Claude accounts, and `ratings.yaml` reflects seeded + observed ratings with correct provenance separation.*

**Phase 3 — Scale-out.**
Duels + regularized Bradley-Terry; agentic discovery (quarantine, approval-before-execution); portable profile export/sharing; cursor-agent adapter (best-effort); adapter conformance suite; HTTP daemon (one per environment scope) + Tasks extension surface.
*Exit criterion: a previously unknown agent app is onboarded end-to-end by an agent — discovered, reviewed, approved, activated, seeded — without the user editing a config file.*

## Open concerns

- MCP 2026-07-28 core and SDK v2 are released; the remaining concern is narrow — host adoption of the Tasks extension (handle-polling fallback covers it).
- Shared profiles remain unsigned opinions; import-diff from day one, signing if a registry ever exists.
- The name "baton" likely collides on npm; check availability (`baton`, `baton-cli`, `@scope/baton`) before publishing.

## Review log

- 2026-08-22 — kimi-k3 and gpt-5.6-sol (round 1, on v1): convergent findings on cwd trust, credential-isolation verification, run_model security surface, discovery injection, eval sample-size realism, static-cost fiction, file-store concurrency → v2. Sol additionally: execution-target ratings with hierarchical priors, run state machine + idempotency, recursion limits, Cursor state-dir gap. Kimi additionally: quota-budget framing, visible degraded adapters, read-time decay bug.
- 2026-08-22 (v3) — user decision: critical identity separation delegated to direnv; enforcement machinery removed, replaced by environment transparency and instance pools.
- 2026-08-22 (v4) — user decisions: renamed Baton; Bun toolchain; derived human-readable ratings YAML; execution modes dropped (permissions caller-owned); seeded priors via onboarding; 3 dogfood-first phases.
- 2026-08-22 (v5) — kimi-k3 and gpt-5.6-sol (round 2, on v4), convergent: authority ceiling restored; pin states + `require_pin`; publication protocol for the derived YAML; priors in an explicit SQLite table; decay rule specified; seeds as confirmed ordinal/pairwise entries with capped precision. Sol additionally: run/attempt split, caller idempotency keys, upsert reports, admission-failure-only failover, attested pool membership, approval-before-canary discovery, deterministic selection policy, portable-only exports, Cursor exclusion, ToS phase gate, narrowed phase 1. Kimi additionally: DIRENV detection, Keychain spike, WAL/busy_timeout, generated-file header, hop-chain reset note.
- 2026-08-25 (phase-2 code review — run through Baton itself) — kimi-k3 and gpt-5.6-sol, both: fix first. Convergent, top severity: admission-failure classification by bare substring match could fail over (= replay the prompt on another instance) after the callee had already produced side effects — fixed with declarative work-started evidence per adapter and pruned admission patterns; when in doubt the run fails, never replays. Also convergent: prior precision never decayed from its `as_of` (stale imports outlived fresh evidence); selection multiplied rating into the quota score instead of the plan's staged ranking. Sol additionally (with exact numeric repros): half-life changes over live evidence corrupt sums (now refused without `--reset-evidence`); out-of-order grade replay (event time now monotonic vs `as_of`); quota recorded at completion not admission (spreading was blind to in-flight runs); kimi installer wrote the wrong project path; codex TOML dotted-key corruption (now refused). Kimi additionally: zero-weight priors still routed (blend now returns null); last-resort selection ran still-cooling instances (now fails with earliest-retry); concurrency cap missed `queued` attempts; cancel/commit race. Identity integrity per both: instances/pools rejected for adapters without an `identityEnv` (opencode), instance removal cleans pool refs, missing overlays fail closed. Deferred to phase 3 with resume/discovery: full fingerprint components (app version, alias epoch), autonomy-aware rating lenses, session-resume surface.
- 2026-08-24 (phase-2 entry gate) — user decision: the multi-account ToS gate is cleared. Anthropic ships first-class fast account switching in Claude Code (login in another terminal applies to active sessions on the next tool call), which the user reads as multi-account use being a supported pattern, not a circumvention. Pools proceed.
- 2026-08-23 (phase-1 code review) — kimi-k3 and gpt-5.6-sol reviewed the built implementation; both: fix first. Convergent: payload-bound idempotency was unimplemented; ceiling below an adapter's supported levels bricked the route instead of excluding it from selection. Sol (reproduced live): fresh-DB migration race across concurrent processes; SIGTERM-ignoring grandchildren surviving "timeout kill". Kimi: instance `--env` values not `~`-expanded (the plan's own example broke); relative `BATON_CONFIG_DIR` splitting CLI and MCP onto different DBs. Also fixed: run-retention cap (privacy promise), concurrency cap, verified-death shutdown paths, absolute-binary spawn, sessionRef head-buffer, availability-cache TTL, 0700 enforcement on pre-existing dirs, `--no-wait` removed from the CLI (async delegation is the MCP server's job). Deferred to phase 2 with the ratings schema, per both reviewers: app-version/alias-epoch in fingerprints, structured per-attempt target identity for failover reporting, auth-aware availability.
- 2026-08-22 (v6) — user decisions: identity machinery deleted wholesale. No pin states, no `require_pin`, no fingerprints, no attestation, no environment scrubbing — Baton executes CLIs in its inherited environment like a shell would, and whatever the environment supplies is what runs. Scope separation moves to **state partitioning via `BATON_CONFIG_DIR`** (set by direnv like the agent apps' own vars): each scope has its own config, instances, quota state, and ratings DB, making cross-scope leakage structurally impossible without runtime checks. Pool-membership attestation dropped (pools are user-defined config, trusted like the rest of the environment). Keychain spike removed — multi-config Claude incl. Keychain confirmed working by the user's real-world direnv setup. v5's identity-context quota keying obsoleted by partitioning.
