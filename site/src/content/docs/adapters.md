---
title: "Adding a new app"
description: "Register an agent CLI and use it immediately, with optional diagnostics."
order: 7
---

An adapter describes an executable, argument arrays, supported permission levels and rules for extracting its answer. Any agent can register one through MCP:

1. Call `discover_app(name)` for the adapter schema and a checklist for inspecting the CLI's non-interactive mode, output and model names.
2. Submit the spec with `register_app(spec)`. Baton validates and stores it. A valid new registration is enabled immediately without a model call.
3. Use `run_model` to delegate. Optionally call `test_app(app, instance?)` first to check execution and answer extraction.

There is no adapter approval flow, digest-copying step or required diagnostic. Identical registrations change nothing. Invalid replacements preserve the working spec, and an explicitly disabled adapter stays disabled when its spec changes.

## From the shell

```sh
baton adapters add ./someapp.json
baton adapters show someapp
baton adapters list
baton adapters test someapp
baton adapters test --all --structural
```

`show` prints the stored spec, including its argument arrays. Arguments are passed directly to the process without a shell, so literal JSON and shell punctuation can be ordinary argument values.

`test` runs an optional diagnostic using the app's subscription. It obeys the account selection, route blocks and permission ceiling for the scope, using the least permissive supported mode that the ceiling allows. A failed test records diagnostic evidence without disabling registration. `--structural` validates declarations without executing the app.

An upgraded CLI can be detected and tested without restoring permission to run it. Upgrading the CLI does not disable its adapter; diagnostics remain optional.

## Enable and disable

The same commands work for built-in and registered adapters:

```sh
baton adapters disable someapp
baton adapters enable someapp
```

Agents can use `set_app_enabled(app, enabled)` through MCP. Explicit disables survive repeated registration and spec updates. Use [route blocks](/docs/blocking) when only certain models, providers or accounts should be excluded.

## Execution and privacy

Baton relies on the permission flags supported by each CLI; it does not add a separate sandbox. It runs the default account with the inherited environment and applies a named account's configured overlay when selected. Baton does not verify who owns those credentials.

Delegated prompts go to the chosen CLI and may be sent to its model provider. Baton stores local run history. Its optional sharing service receives profile priors and sharing-account information, without run prompts or transcripts.
