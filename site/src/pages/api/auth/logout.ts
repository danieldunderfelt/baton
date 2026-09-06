import type { APIRoute } from "astro";

import { handle } from "../../../lib/api.ts";
import { assertSameOrigin, signOut } from "../../../lib/auth.ts";
import { appEnv } from "../../../lib/env.ts";

export const prerender = false;

/** Browser sign-out (form post from the header). */
export const POST: APIRoute = ({ request, cookies, redirect }) =>
  handle(async () => {
    assertSameOrigin(request);
    await signOut(appEnv(), cookies);
    return redirect("/", 302);
  });
