import type { APIRoute } from "astro";

import { beginGithubLogin, safeNext } from "../../../lib/auth.ts";
import { appEnv, siteOrigin } from "../../../lib/env.ts";

export const prerender = false;

export const GET: APIRoute = ({ request, cookies }) => {
  const env = appEnv();
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  return beginGithubLogin(env, request, cookies, siteOrigin(request), next);
};
