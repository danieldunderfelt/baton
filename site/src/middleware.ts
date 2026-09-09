import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  const protectedResponse = new Response(response.body, response);
  protectedResponse.headers.set(
    "content-security-policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  protectedResponse.headers.set("x-frame-options", "DENY");
  protectedResponse.headers.set("x-content-type-options", "nosniff");
  protectedResponse.headers.set("referrer-policy", "no-referrer");
  return protectedResponse;
});
