import type { APIRoute } from "astro";

import { ApiError, handle, json, readJson } from "../../../lib/api.ts";
import { redeemDevice } from "../../../lib/db.ts";
import { appEnv } from "../../../lib/env.ts";

export const prerender = false;

/** The CLI's poll. Error codes follow RFC 8628 so the loop is boring. */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const env = appEnv();
    const body = (await readJson(request)) as { device_code?: unknown };
    if (typeof body.device_code !== "string" || !body.device_code) {
      throw new ApiError(400, "bad_request", "device_code is required.");
    }
    const result = await redeemDevice(env.DB, body.device_code);
    switch (result.status) {
      case "ok":
        return json({ token: result.token, login: result.login });
      case "pending":
        throw new ApiError(400, "authorization_pending", "Waiting for the code to be confirmed in the browser.");
      case "expired":
        throw new ApiError(400, "expired_token", "The sign-in code expired. Run 'baton login' again.");
      default:
        throw new ApiError(400, "invalid_grant", "Unknown device code.");
    }
  });
