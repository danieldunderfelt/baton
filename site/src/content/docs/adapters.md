---
title: "Adding a new app"
description: "Onboard an agent CLI Baton has never heard of, with a human approval step."
order: 7
---

Any agent can onboard an app Baton has never heard of, without editing any config file:

1. The agent calls `discover_app("someapp")` and gets a checklist: probe the CLI, find its non-interactive mode, its output format, its model names.
2. It submits what it found with `register_app(spec)`. The spec is: an executable path, argument lists, and rules for extracting the answer. Baton validates it and stores it quarantined — it executes nothing from it yet.
3. You review and approve in the terminal: `baton adapters review someapp` shows the exact binary, argv and env names, then `baton adapters approve someapp --digest <shown-in-review>` approves. Approval requires a terminal and the digest of the exact spec you reviewed; re-submitting a spec re-quarantines it, because approval is consent to one reviewed spec.
4. Baton runs one canary prompt through the app to verify the answer comes back intact, then activates it. From then on it routes like any built-in app or provider.

`baton adapters list` shows built-in and discovered adapters, `baton adapters canary <app|--all>` re-runs the conformance suite on demand, and `baton adapters reject <app> [reason...]` records a verdict — for a discovered app a rejection of its spec, for a built-in a block on every route it has (see [Blocking routes and scopes](/docs/blocking)).

If the app's binary is later upgraded, the adapter is marked stale and re-verified before it runs again.

## What Baton does not do

- It does not verify identity. Environment separation is your direnv setup's job; Baton just inherits what it is given. `baton block` is the escape hatch for routes you know must not be spent — a rule you state, not one Baton infers.
- It does not sandbox callees beyond the autonomy flags each CLI itself offers. You choose what your agents may do.
- It cannot stop a full-permission local agent from doing what you yourself could do in a terminal, including approving adapters. The approval step protects against accidents, not against an agent you have already given full access to your shell.
- Raw prompts stay on your machine, in a capped ring buffer (about 2,000 runs). Only aggregate ratings are shareable.
