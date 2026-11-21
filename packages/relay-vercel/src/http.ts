/**
 * Small shared HTTP helpers for the api/ route entry points. The route
 * files stay thin (parse -> lib -> Response); these are the response
 * shapes every route shares (contract §3.4 CORS, §9 wire reference).
 */

/** The stats family is public data: every route is CORS-open (§3.4). */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-expose-headers": "etag, x-wowsp-cache, age, retry-after",
  "access-control-max-age": "86400",
};

/** Answer a CORS preflight (204, no body). */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export interface JsonInit {
  status?: number;
  headers?: Record<string, string>;
}

/** JSON body + CORS, the only success envelope the routes emit. */
export function jsonResponse(body: unknown, init: JsonInit = {}): Response {
  const headers: Record<string, string> = { ...CORS_HEADERS, "content-type": "application/json", ...init.headers };
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/**
 * Error envelope: `{"error":"<code>"}` (the shapes the contract spells
 * out: forbidden_host §3.1, upstream_failed §3.1, not_found §4.2).
 */
export function errorResponse(status: number, code: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: code }, { status, headers });
}

/** 405 with the usual Allow header. */
export function methodNotAllowed(allow: string): Response {
  return errorResponse(405, "method_not_allowed", { allow });
}

/**
 * Top-level catch for every route body: unexpected failures collapse to
 * a bare 500 {"error":"internal"} instead of a runtime crash page.
 */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch {
    return errorResponse(500, "internal");
  }
}

/**
 * The caller IP for per-IP budgets (§3.5, §5.2.4). Vercel edge sets
 * `x-forwarded-for` (client first) and `x-real-ip`; everything else
 * collapses to "unknown" and shares one bucket.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Read a JSON request body with a byte cap (announce bodies, 8 KiB). */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > maxBytes) {
    throw new BodyTooLargeError();
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

/** Thrown by {@link readJsonBody} when the body exceeds the cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
  }
}

/** Concatenate chunks into one array (no spread: bodies reach 8 MiB). */
export function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a response body up to `maxBytes`; returns `null` when the body
 * EXCEEDS the cap (the reader is cancelled). Used for peer block bodies
 * and health probes so a hostile endpoint cannot balloon memory with an
 * endless stream -- unlike `response.text()`, this never buffers more
 * than the cap.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(chunks, total);
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
  }
}
