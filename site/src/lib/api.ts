/** JSON helpers for the API routes; every error is `{ error, message }`. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return json({ error: err.code, message: err.message }, err.status);
  console.error(err);
  return json({ error: "internal", message: "Something went wrong on the server." }, 500);
}

/** Runs a handler and turns thrown ApiErrors (or anything else) into JSON. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}

const MAX_BODY_BYTES = 256 * 1024;

export async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "too_large", "Request body is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "too_large", "Request body is too large.");
  if (!text.trim()) throw new ApiError(400, "bad_request", "Expected a JSON body.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "bad_request", "Body is not valid JSON.");
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}
