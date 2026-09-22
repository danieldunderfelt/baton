import type { APIRoute } from "astro";

import { ApiError, handle, json, readJsonObject } from "../../../lib/api.ts";
import { createDeviceCode, DeviceLimitError, purgeExpired } from "../../../lib/db.ts";
import { appEnv, siteOrigin } from "../../../lib/env.ts";

export const prerender = false;

/** Step one of `baton login`: a device code for the CLI, a user code for the human. */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const env = appEnv();
    const body = await readJsonObject(request);
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "cli";
    if ([...label].some((ch) => ch.charCodeAt(0) < 32)) {
      throw new ApiError(400, "bad_request", "label must be a single line.");
    }
    await purgeExpired(env.DB);
    let start;
    try {
      // Cloudflare supplies this address. Do not accept a caller's forwarded-for
      // header; a missing edge header shares a bucket, including local preview.
      start = await createDeviceCode(env.DB, label, request.headers.get("cf-connecting-ip") ?? "unknown");
    } catch (err) {
      if (err instanceof DeviceLimitError) {
        return json({ error: "too_many_requests", message: err.message }, 429,
          { "retry-after": String(err.retryAfterSeconds) });
      }
      throw err;
    }
    const origin = siteOrigin(request);
    return json({
      ...start,
      verification_uri: `${origin}/device`,
      verification_uri_complete: `${origin}/device?code=${start.user_code}`,
    });
  });
