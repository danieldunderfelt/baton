import type { APIRoute } from "astro";

import { ApiError, handle, json, readJson } from "../../../lib/api.ts";
import { createDeviceCode, pendingDeviceCount, purgeExpired } from "../../../lib/db.ts";
import { appEnv, siteOrigin } from "../../../lib/env.ts";

export const prerender = false;

const MAX_PENDING_DEVICES = 500;

/** Step one of `baton login`: a device code for the CLI, a user code for the human. */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const env = appEnv();
    const body = (await readJson(request)) as { label?: unknown };
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "cli";
    if ([...label].some((ch) => ch.charCodeAt(0) < 32)) {
      throw new ApiError(400, "bad_request", "label must be a single line.");
    }
    await purgeExpired(env.DB);
    // Nobody signs in a thousand CLIs at once; a flood of anonymous requests is
    // the only thing that gets here, and this keeps it from growing the table.
    if ((await pendingDeviceCount(env.DB)) >= MAX_PENDING_DEVICES) {
      throw new ApiError(429, "too_many_requests", "Too many sign-ins are pending. Try again in a few minutes.");
    }
    const start = await createDeviceCode(env.DB, label);
    const origin = siteOrigin(request);
    return json({
      ...start,
      verification_uri: `${origin}/device`,
      verification_uri_complete: `${origin}/device?code=${start.user_code}`,
    });
  });
