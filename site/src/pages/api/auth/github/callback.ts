import type { APIRoute } from "astro";

import { errorResponse } from "../../../../lib/api.ts";
import { finishGithubLogin, signIn } from "../../../../lib/auth.ts";
import { upsertUser } from "../../../../lib/db.ts";
import { appEnv, siteOrigin } from "../../../../lib/env.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const env = appEnv();
  try {
    const { identity, next } = await finishGithubLogin(env, request, cookies, siteOrigin(request));
    const user = await upsertUser(env.DB, identity);
    await signIn(env, request, cookies, user);
    return redirect(next, 302);
  } catch (err) {
    return errorResponse(err);
  }
};
