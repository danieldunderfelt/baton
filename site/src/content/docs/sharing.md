---
title: "Sharing profiles"
description: "Move ratings priors between machines with a link or a short code."
order: 4
---

Profiles contain model priors without local run history or account configuration. The optional Baton sharing service lets you transfer a profile through a link or short code. Profile names and categories are free text and are included in the document.

## Signing in

```sh
baton login
```

`baton login` signs in with GitHub. It prints a URL and a short code; you open the URL in a browser on any machine, sign in with GitHub, confirm the code, and the CLI receives a token. The token is stored in Baton's config directory with owner-only permissions (`auth.json`). Each `BATON_CONFIG_DIR` scope has its own login. `baton logout` removes the token and revokes it on the server.

Device codes expire after 15 minutes. The service permits five pending codes and ten new sign-in requests per client address in a 15-minute window, with a global cap of 500 pending codes. Clients sharing a public IP share a limit. A throttled request receives HTTP 429 with `Retry-After`; wait before starting another sign-in.

## Sharing

```sh
baton profile share                  # the active profile
baton profile share --profile work   # a named one
```

This uploads the profile and prints a share code and a link, e.g. `https://baton.sh/p/k7mq3-v2xrd`. If you are not signed in, it starts the sign-in flow first. Sharing the same profile name again updates the same share in place, so a link you already gave someone keeps pointing at your latest priors.

Category names export verbatim. Baton prints a reminder before sharing so you can spot names that identify a client or project.

## Importing

The recipient runs:

```sh
baton profile import k7mq3-v2xrd --dry-run       # optional preview
baton profile import k7mq3-v2xrd                 # import immediately, or use the full URL
```

Import fetches the document, applies it and prints the changes. `--dry-run` previews without changing priors. Shared profiles default to the local name `<github-login>/<profile-name>`; use `--name <n>` to choose another name. The first profile activates automatically. Later imports leave the current profile selected unless `--activate` is supplied; `baton set active_profile <name>` switches later.

Replacing an existing profile saves a previous-version file under `profile-backups` in the scope's config directory and prints a restore command. Entries omitted from the replacement are removed from that local profile.

Opening the link in a browser shows the profile: who shared it, when, the table of models with category, mean and weight, and the import command. There is no directory of profiles: nothing is browseable, and a share is reachable only by its code.

## Managing shares

- `baton profile shares` lists your own shares: code, name, entries, when last updated.
- `baton profile unshare <code>` revokes one; the link stops working immediately. Signing in on the website shows the same list with a revoke button.

Each account can store up to 100 profiles and 5 MiB of profile JSON in total. An upload that exceeds either limit is rejected without replacing the existing share. Delete an unused share or reduce the document before retrying.

The API lists 25 profiles per page by default, with a maximum page size of 100. Responses include `shares` and `next_cursor`; pass that cursor to the next `GET /api/profiles` request until it is null. The CLI fetches every page automatically, and the account page offers more results as needed.

## Privacy

The sharing service receives the profile document, GitHub login and avatar for attribution, and sign-in information. Signing in records a generic operating-system device label instead of a hostname. The service also uses a hashed client-address identifier for sign-in throttling. Run prompts, transcripts, grades and configured callee accounts are not uploaded by profile sharing. Shares are public to anyone holding the code, including their free-text names and categories.

Delegation is a separate operation: the selected CLI receives the task prompt and may send it to its model provider. Baton's local run history should not be confused with a promise that prompts never leave the machine.

The site URL can be overridden with the `BATON_SITE_URL` environment variable, for self-hosting or local testing of the site.
