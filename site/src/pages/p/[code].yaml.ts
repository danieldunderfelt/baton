import type { APIRoute } from "astro";

import { renderProfile } from "../../../../src/eval/profileDocument.ts";
import { normalizeShareCode } from "../../lib/codes.ts";
import { profileByCode } from "../../lib/db.ts";
import { appEnv } from "../../lib/env.ts";

export const prerender = false;

/** The share as the same file `baton profile export` would have written. */
export const GET: APIRoute = async ({ params }) => {
  const code = normalizeShareCode(params.code ?? "");
  const share = code ? await profileByCode(appEnv().DB, code) : null;
  if (!share) return new Response("Not found", { status: 404 });
  return new Response(renderProfile(share.profile), {
    headers: {
      "content-type": "text/yaml; charset=utf-8",
      "content-disposition": `attachment; filename="${share.name.replace(/[^\w.-]+/g, "-")}.yaml"`,
      "cache-control": "no-store",
    },
  });
};
