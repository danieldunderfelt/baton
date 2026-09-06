# Baton website

The landing page, the docs, and the profile-sharing service. Astro 7 on Cloudflare Workers; shares, sessions and CLI tokens live in a D1 database; sign-in is GitHub OAuth. The static pages are prerendered, the sharing routes (`/api/*`, `/p/<code>`, `/device`, `/account`) run in the Worker.

The profile format is validated with the same code the CLI uses (`../src/eval/profileDocument.ts`), so a document the site accepts is one the CLI accepts.

## Run it locally

1. Create a GitHub OAuth app at <https://github.com/settings/developers> with callback URL `http://localhost:4321/api/auth/github/callback`. Scopes are not needed.
2. `cp .dev.vars.example .dev.vars` and fill in the client id and secret.
3. Install, migrate the local database, start the dev server:

```sh
bun install
bun run db:migrate:local
bun run dev            # http://localhost:4321
```

The dev server runs in `workerd` with the bindings from `wrangler.jsonc`; local D1 state persists in `.wrangler/`.

To try the sharing flow with the real CLI against the local site:

```sh
export BATON_SITE_URL=http://localhost:4321
baton login                    # prints a link and a code; confirm it in the browser
baton profile share            # then open the link it prints
baton profile import <code>    # from any scope, e.g. BATON_CONFIG_DIR=/tmp/other
```

Checks: `bun test` (pure helpers), `bun run check` (Astro + TypeScript), `bun run build`.

## Deploy

Once, per Cloudflare account:

```sh
bunx wrangler login
bunx wrangler d1 create baton            # paste the database_id into wrangler.jsonc
bun run db:migrate:remote
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
```

Use a second GitHub OAuth app for production, with the callback `https://<your host>/api/auth/github/callback`. Then:

```sh
bun run deploy                            # astro build && wrangler deploy
```

Links the CLI prints use the origin of the request that created them. Set `"vars": { "SITE_URL": "https://..." }` in `wrangler.jsonc` only if the Worker is reachable under more than one host and one should be canonical.

The CLI's default site is `DEFAULT_SITE_URL` in `../src/cli/share.ts`; change it when the domain is decided, and the `site` field in `astro.config.mjs` with it.

## Layout

- `src/pages/index.astro` — landing page. `src/pages/docs/[slug].astro` renders `src/content/docs/*.md` in `order`.
- `src/pages/api/` — JSON endpoints the CLI calls: device flow, profiles, token revoke; plus the GitHub OAuth redirect and callback.
- `src/pages/p/[code].astro` — a shared profile; `[code].yaml.ts` is the same as a downloadable file.
- `src/pages/device.astro` — where a browser confirms a `baton login` code. `src/pages/account.astro` — your shares and signed-in CLIs.
- `src/lib/db.ts` — every query; secrets are stored hashed. `src/lib/auth.ts` — sessions, bearer tokens, GitHub OAuth.
- `migrations/` — D1 schema.
