import type { APIRoute } from "astro";

import { validateProfileDocument } from "../../../../../src/eval/profileDocument.ts";
import { ApiError, handle, json, readJson } from "../../../lib/api.ts";
import { requireTokenUser } from "../../../lib/auth.ts";
import { InvalidProfilePageError, listProfiles, ProfileLimitError, upsertProfile } from "../../../lib/db.ts";
import { appEnv, siteOrigin } from "../../../lib/env.ts";

export const prerender = false;

/** `baton profile share`: publish (or refresh) a profile document. */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const env = appEnv();
    const { user } = await requireTokenUser(env, request);
    let doc;
    try {
      doc = validateProfileDocument(await readJson(request), "profile");
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, "invalid_profile", err instanceof Error ? err.message : String(err));
    }
    try {
      const share = await upsertProfile(env.DB, user.id, doc);
      return json({ ...share, url: `${siteOrigin(request)}/p/${share.code}` });
    } catch (err) {
      if (err instanceof ProfileLimitError) throw new ApiError(409, "profile_limit", err.message);
      throw err;
    }
  });

/** `baton profile shares`: the caller's own shares, nobody else's. */
export const GET: APIRoute = ({ request }) =>
  handle(async () => {
    const env = appEnv();
    const { user } = await requireTokenUser(env, request);
    const origin = siteOrigin(request);
    const params = new URL(request.url).searchParams;
    try {
      const page = await listProfiles(env.DB, user.id, {
        cursor: params.get("cursor"),
        ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
      });
      const shares = page.shares.map((s) => ({ ...s, url: `${origin}/p/${s.code}` }));
      return json({ shares, next_cursor: page.next_cursor });
    } catch (err) {
      if (err instanceof InvalidProfilePageError) throw new ApiError(400, "bad_request", err.message);
      throw err;
    }
  });
