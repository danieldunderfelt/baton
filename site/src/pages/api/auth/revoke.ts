import type { APIRoute } from "astro";

import { handle, noContent } from "../../../lib/api.ts";
import { requireTokenUser } from "../../../lib/auth.ts";
import { deleteToken } from "../../../lib/db.ts";
import { appEnv } from "../../../lib/env.ts";

export const prerender = false;

/** `baton logout`: the CLI revokes its own token. */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const env = appEnv();
    const { token } = await requireTokenUser(env, request);
    await deleteToken(env.DB, token);
    return noContent();
  });
