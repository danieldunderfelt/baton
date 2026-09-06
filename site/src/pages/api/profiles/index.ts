import type { APIRoute } from "astro";

import { validateProfileDocument } from "../../../../../src/eval/profileDocument.ts";
import { ApiError, handle, json, readJson } from "../../../lib/api.ts";
import { requireTokenUser } from "../../../lib/auth.ts";
import { listProfiles, upsertProfile } from "../../../lib/db.ts";
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
    const share = await upsertProfile(env.DB, user.id, doc);
    return json({ ...share, url: `${siteOrigin(request)}/p/${share.code}` });
  });

/** `baton profile shares`: the caller's own shares, nobody else's. */
export const GET: APIRoute = ({ request }) =>
  handle(async () => {
    const env = appEnv();
    const { user } = await requireTokenUser(env, request);
    const origin = siteOrigin(request);
    const shares = (await listProfiles(env.DB, user.id)).map((s) => ({ ...s, url: `${origin}/p/${s.code}` }));
    return json({ shares });
  });
