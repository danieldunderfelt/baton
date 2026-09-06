---
title: "Sharing profiles"
description: "Move ratings priors between machines with a link or a short code."
order: 4
---

Profiles are the portable part of Baton's ratings: canonical model priors only, never prompts, accounts, instances, or machine details — the export format refuses anything else. The Baton website hosts a small sharing service so a profile can travel from one Baton CLI to another with a link or a short code, instead of passing files around.

## Signing in

```sh
baton login
```

`baton login` signs in with GitHub. It prints a URL and a short code; you open the URL in a browser on any machine, sign in with GitHub, confirm the code, and the CLI receives a token. The token is stored in Baton's config directory with owner-only permissions (`auth.json`). Each `BATON_CONFIG_DIR` scope has its own login. `baton logout` removes the token and revokes it on the server.

## Sharing

```sh
baton profile share                  # the active profile
baton profile share --profile work   # a named one
```

This uploads the profile and prints a share code and a link, e.g. `https://baton.sh/p/k7mq3-v2xrd`. If you are not signed in, it starts the sign-in flow first. Sharing the same profile name again updates the same share in place, so a link you already gave someone keeps pointing at your latest priors.

Before uploading, Baton warns that category names are free text and export verbatim — check that none names a client or project.

## Importing

The recipient runs:

```sh
baton profile import k7mq3-v2xrd                 # or the full URL
baton profile import k7mq3-v2xrd --yes           # after reading the diff
```

The first run fetches the profile and prints the same diff a file import would — added, changed and unchanged priors — and writes nothing until re-run with `--yes`. By default the priors land in a local profile named `<github-login>/<profile-name>` so they never collide with your own profiles; `--name <n>` overrides that and `--activate` switches to it after import. `baton set active_profile <name>` switches later.

Opening the link in a browser shows the profile: who shared it, when, the table of models with category, mean and weight, and the import command. There is no directory of profiles: nothing is browseable, and a share is reachable only by its code.

## Managing shares

- `baton profile shares` lists your own shares: code, name, entries, when last updated.
- `baton profile unshare <code>` revokes one; the link stops working immediately. Signing in on the website shows the same list with a revoke button.

## Privacy

The only data uploaded is the profile document itself (name, timestamp, and per-model entries) plus your GitHub login and avatar for attribution. Signing in records a generic device label (the operating system, not the hostname) so you can tell tokens apart on the account page. No prompts, runs, grades, account names, or machine details ever leave the machine. Shares are public to anyone holding the code.

The site URL can be overridden with the `BATON_SITE_URL` environment variable, for self-hosting or local testing of the site.
