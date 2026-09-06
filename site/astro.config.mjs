// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://baton.sh",
  output: "static",
  // Auth and sharing keep their own tables in D1; Astro's KV-backed session
  // store would be a second, unused state store.
  session: false,
  adapter: cloudflare({
    imageService: "compile",
    persistState: true,
  }),
  redirects: { "/docs": "/docs/installation" },
  // Cookie-authenticated form posts check their Origin themselves (lib/auth.ts
  // assertSameOrigin); bearer-token API calls carry no cookie to forge, and
  // Astro's blanket check would 403 a bodiless DELETE from curl or the CLI.
  security: { checkOrigin: false },
  build: { inlineStylesheets: "auto" },
});
