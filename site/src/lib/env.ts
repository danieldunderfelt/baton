import { env } from "cloudflare:workers";

/** Bindings and secrets from wrangler.jsonc and `.dev.vars`. */
export interface AppEnv {
  DB: D1Database;
  SITE_URL?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export function appEnv(): AppEnv {
  return env as unknown as AppEnv;
}

/** Public origin of this deployment, for links the CLI prints and OAuth callbacks. */
export function siteOrigin(request: Request): string {
  return (appEnv().SITE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}
