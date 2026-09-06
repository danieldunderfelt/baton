import type { APIRoute } from "astro";

import { ApiError, handle, json, noContent } from "../../../lib/api.ts";
import { requireTokenUser } from "../../../lib/auth.ts";
import { normalizeShareCode } from "../../../lib/codes.ts";
import { deleteProfile, profileByCode } from "../../../lib/db.ts";
import { appEnv, siteOrigin } from "../../../lib/env.ts";

export const prerender = false;

function codeParam(params: Record<string, string | undefined>): string {
  const code = normalizeShareCode(params.code ?? "");
  if (!code) throw new ApiError(404, "not_found", "No shared profile with that code.");
  return code;
}

/** `baton profile import <code>`: public, the code is the only key. */
export const GET: APIRoute = ({ params, request }) =>
  handle(async () => {
    const env = appEnv();
    const code = codeParam(params);
    const share = await profileByCode(env.DB, code);
    if (!share) throw new ApiError(404, "not_found", "No shared profile with that code.");
    return json({ ...share, url: `${siteOrigin(request)}/p/${share.code}` });
  });

/** `baton profile unshare <code>`: only the owner can. */
export const DELETE: APIRoute = ({ params, request }) =>
  handle(async () => {
    const env = appEnv();
    const { user } = await requireTokenUser(env, request);
    const code = codeParam(params);
    if (!(await deleteProfile(env.DB, user.id, code))) {
      throw new ApiError(404, "not_found", "No shared profile with that code among yours.");
    }
    return noContent();
  });
