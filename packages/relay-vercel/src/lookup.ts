/**
 * `GET|POST /api/lookup/fetch?url=<percent-encoded absolute upstream URL>`
 * -- the stats-cache proxy (contract §3).
 *
 * Order of operations (each step cites the contract):
 *   1. per-IP hourly budget            §3.5
 *   2. allowlist gate (https + host)   §3.1/§3.2
 *   3. POST body (<= 8 KiB)            §3.1
 *   4. canonical line -> CID           §3.3/§4.1
 *   5. fresh local row? -> hit         §3.3/§3.4
 *   6. peer pull (<= SYNC_PEERS_MAX)   §5.4
 *   7. upstream fetch -> store -> miss §3.1/§3.3
 */

import { readConfig, type RuntimeConfig } from "./config";
import {
  base64ToBytes,
  bytesToBase64,
  envelopeFresh,
  envelopeRemaining,
  envelopeAge,
  epochSeconds,
  parseEnvelope,
  serializeEnvelope,
  type Envelope,
} from "./envelope";
import { clientIp, errorResponse, guarded, methodNotAllowed, preflight, readCapped, concatBytes } from "./http";
import type { Kv } from "./kv";
import { openKv } from "./kv";
import { collectPeerRows } from "./peers";
import { rateLimit } from "./ratelimit";
import { ALLOWLIST, BROWSER_UA, canonicalRequestLine, cidOfRequest, cidVerify, classifyTtl, sha256Hex } from "./policy";

/** Upstream fetch budget: 15 s total (§3.1). */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Response cap: 8 MiB (§3.1); larger bodies pass through uncached. */
const UPSTREAM_BODY_CAP = 8 * 1024 * 1024;
/** POST request bodies forwarded verbatim up to 8 KiB (§3.1). */
const REQUEST_BODY_CAP = 8 * 1024;
/** Peer block pull budget per peer (§5.4). */
const PEER_PULL_TIMEOUT_MS = 3_000;
/** Late peer-hit grace added to every stored TTL (§4.3). */
const STORE_GRACE_SECONDS = 86_400;

export type GateResult =
  | { ok: true; url: URL }
  | { ok: false; status: number; code: string };

/**
 * The allowlist gate (§3.1/§3.2): https-only, host on the 13-entry
 * allowlist. Two adapter-level strictness additions, both documented
 * in the README: userinfo (`https://user:pass@host`) and an explicit
 * port are rejected as `invalid_url` -- canonical request lines are
 * cache keys, and they must never embed credentials or non-default
 * origins.
 */
export function gateUpstreamUrl(raw: string): GateResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 400, code: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, status: 403, code: "forbidden_host" };
  if (url.username !== "" || url.password !== "") return { ok: false, status: 400, code: "invalid_url" };
  if (url.port !== "") return { ok: false, status: 400, code: "invalid_url" };
  if (!ALLOWLIST.has(url.hostname.toLowerCase())) return { ok: false, status: 403, code: "forbidden_host" };
  return { ok: true, url };
}

/** §3.4 response headers + provenance, the one way envelopes are served. */
export function serveEnvelope(envelope: Envelope, cache: "hit" | "miss" | "peer-hit"): Response {
  const headers: Record<string, string> = {
    "content-type": envelope.contentType || "application/json",
    "cache-control": `public, max-age=${envelopeRemaining(envelope)}`,
    "x-wowsp-cache": cache,
    age: String(envelopeAge(envelope)),
    "access-control-allow-origin": "*",
  };
  return new Response(base64ToBytes(envelope.bodyB64) as unknown as BodyInit, { status: 200, headers });
}

type UpstreamOutcome =
  | { kind: "ok"; bytes: Uint8Array; status: number; contentType: string }
  | { kind: "overCap"; stream: ReadableStream<Uint8Array>; contentType: string };

class UpstreamFailedError extends Error {}

/**
 * The upstream fetch (§3.1): browser UA, 15 s total budget, manual
 * redirect following with the FINAL-host-must-equal rule (§3.2), 8 MiB
 * read cap with uncached pass-through for oversized bodies.
 *
 * `UPSTREAM_OVERRIDE` (test/air-gapped only) rewrites the base URL of
 * an allowlisted host before fetching; the allowlist gate ran on the
 * ORIGINAL host already.
 */
async function fetchUpstream(
  rawUrl: string,
  method: string,
  body: Uint8Array | null,
  contentType: string | null,
  cfg: RuntimeConfig,
): Promise<UpstreamOutcome> {
  const parsed = new URL(rawUrl);
  const override = cfg.upstreamOverride.get(parsed.hostname.toLowerCase());
  let target = new URL(override ? override.replace(/\/+$/, "") + parsed.pathname + parsed.search : rawUrl);
  const originalHost = target.host; // every redirect hop must stay here (§3.2)
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
  let currentMethod = method;
  let currentBody: Uint8Array | null = body;
  let currentContentType = contentType;

  for (let hop = 0; hop < 6; hop += 1) {
    const controller = new AbortController();
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      const headers: Record<string, string> = { "user-agent": BROWSER_UA };
      if (currentBody !== null && currentContentType !== null) headers["content-type"] = currentContentType;
      response = await fetch(target.href, {
        method: currentMethod,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(currentBody !== null ? { body: currentBody as unknown as BodyInit } : {}),
      });
    } catch (err) {
      throw new UpstreamFailedError(String(err));
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      // §3.2: redirects are followed, but every hop must stay on the
      // original host -- a cross-host hop is a policy failure, not a
      // document.
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new UpstreamFailedError("bad redirect");
      }
      if (next.host !== originalHost) throw new UpstreamFailedError("cross-host redirect");
      // Scheme changes are refused too: in normal operation the chain is
      // https and an http://same-host downgrade must not be followed.
      // (Equality, not a hard https check, because UPSTREAM_OVERRIDE
      // air-gapped bases may deliberately be non-https from hop one.)
      if (next.protocol !== target.protocol) throw new UpstreamFailedError("scheme-change redirect");
      if (currentMethod === "POST" && (response.status === 301 || response.status === 302 || response.status === 303)) {
        currentMethod = "GET"; // classic redirect downgrade
        currentBody = null;
        currentContentType = null;
      }
      // 307/308 keep method + body. Loop by rewriting the fetch target.
      target = next;
      continue;
    }
    if (!response.ok) throw new UpstreamFailedError(`upstream status ${response.status}`);

    const responseContentType = response.headers.get("content-type") ?? "application/json";
    const reader = response.body?.getReader();
    if (!reader) return { kind: "ok", bytes: new Uint8Array(0), status: response.status, contentType: responseContentType };

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { kind: "ok", bytes: concatBytes(chunks, total), status: response.status, contentType: responseContentType };
      chunks.push(value);
      total += value.byteLength;
      if (total > UPSTREAM_BODY_CAP) {
        // §3.1: over-cap bodies pass through UNCACHED, streamed once.
        const stream = spliceStream(chunks, reader);
        return { kind: "overCap", stream, contentType: responseContentType };
      }
    }
  }
  throw new UpstreamFailedError("too many redirects");
}

/** Buffered prefix + the still-live reader remainder, as one stream. */
function spliceStream(buffered: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = buffered.shift();
      if (next !== undefined) {
        controller.enqueue(next);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
}

/** Peer block bodies are capped like upstream bodies (§3.1's 8 MiB). */
const PEER_BLOCK_CAP = 8 * 1024 * 1024;

/**
 * §5.4 pull-through sync: ask up to SYNC_PEERS_MAX lookup-capable peers
 * (own table first, then the upstream list) for the block, 3 s each,
 * and trust a row ONLY when it carries its canonical request line and
 * that line hashes to the CID we asked for (the relay-core PR #2067
 * envelope `line` field; §4.2 content verification, fail closed).
 */
async function pullFromPeers(
  kv: Kv,
  cfg: RuntimeConfig,
  cid: string,
): Promise<{ envelope: Envelope; raw: string } | null> {
  const rows = (await collectPeerRows(kv, cfg)).filter((row) => row.capabilities?.lookup === true);
  for (const row of rows.slice(0, cfg.syncPeersMax)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PEER_PULL_TIMEOUT_MS);
    try {
      const response = await fetch(`${row.url}/api/blocks/${cid}`, { signal: controller.signal });
      if (!response.ok) continue;
      const bytes = await readCapped(response, PEER_BLOCK_CAP);
      if (bytes === null) continue; // oversized peer body -- untrusted, skip
      const raw = new TextDecoder().decode(bytes);
      const envelope = parseEnvelope(raw);
      if (envelope === null) continue;
      if (envelope.status < 200 || envelope.status > 299) continue; // never serve a peer's error page
      // Fail closed: no carried line, no trust (rows from older nodes
      // or foreign 200s are simply not usable -- fall through to the
      // next peer / upstream).
      if (envelope.line === null) continue;
      // Real verification: the PEER-declared line must hash to the CID
      // we independently asked for. A lying peer's row drops here.
      if (!(await cidVerify(cid, envelope.line))) continue;
      return { envelope, raw };
    } catch {
      // unreachable/slow peer -> next peer (§5.4: all misses -> upstream)
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** The /api/lookup/fetch handler body (the route file stays thin). */
export async function handleLookup(request: Request): Promise<Response> {
  return guarded(async () => {
    if (request.method === "OPTIONS") return preflight();
    if (request.method !== "GET" && request.method !== "POST") {
      return methodNotAllowed("GET, POST, OPTIONS");
    }
    const cfg = readConfig();
    const kv = openKv(cfg.kvRestUrl, cfg.kvRestToken);

    const budget = await rateLimit(kv, "lookup", clientIp(request), cfg.lookupRatePerHour);
    if (!budget.allowed) {
      return errorResponse(429, "rate_limited", { "retry-after": String(budget.retryAfter) });
    }

    const rawUrl = new URL(request.url).searchParams.get("url");
    if (rawUrl === null || rawUrl === "") return errorResponse(400, "missing_url");
    const gate = gateUpstreamUrl(rawUrl);
    if (!gate.ok) return errorResponse(gate.status, gate.code);

    let body: Uint8Array | null = null;
    let bodySha256: string | null = null;
    let requestContentType: string | null = null;
    if (request.method === "POST") {
      body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > REQUEST_BODY_CAP) return errorResponse(413, "body_too_large");
      bodySha256 = await sha256Hex(body);
      requestContentType = request.headers.get("content-type");
    }

    const line = canonicalRequestLine(request.method, rawUrl, bodySha256);
    const cid = await cidOfRequest(line);

    // KV read failures degrade to a miss -- the cache is an
    // optimization, never a dependency of the route (finding 7).
    let stored: Envelope | null = null;
    try {
      stored = parseEnvelope(await kv.get(`block:${cid}`));
    } catch {
      stored = null;
    }
    if (stored !== null && envelopeFresh(stored)) return serveEnvelope(stored, "hit");

    if (cfg.peersSync) {
      const pulled = await pullFromPeers(kv, cfg, cid);
      if (pulled !== null) {
        // Store what the peer served (its own fetchedAt/ttl/line travel
        // with the row); a store failure still serves (best-effort).
        await kv
          .setTtl(`block:${cid}`, pulled.raw, pulled.envelope.ttl + STORE_GRACE_SECONDS)
          .catch(() => undefined);
        return serveEnvelope(pulled.envelope, "peer-hit");
      }
    }

    try {
      const outcome = await fetchUpstream(rawUrl, request.method, body, requestContentType, cfg);
      if (outcome.kind === "overCap") {
        const headers: Record<string, string> = {
          "content-type": outcome.contentType,
          "cache-control": "no-store",
          "x-wowsp-cache": "miss",
          age: "0",
          "access-control-allow-origin": "*",
        };
        return new Response(outcome.stream as unknown as BodyInit, { status: 200, headers });
      }
      const host = gate.url.hostname.toLowerCase();
      const ttl = classifyTtl(host, gate.url.pathname);
      const envelope: Envelope = {
        v: 1,
        status: outcome.status,
        contentType: outcome.contentType,
        bodyB64: bytesToBase64(outcome.bytes),
        fetchedAt: epochSeconds(),
        ttl,
        upstream: host,
        // Own writes always carry the line so peers can verify this row
        // (relay-core PR #2067; see src/envelope.ts).
        line,
      };
      await kv
        .setTtl(`block:${cid}`, serializeEnvelope(envelope), ttl + STORE_GRACE_SECONDS)
        .catch(() => undefined); // store failure still serves the document
      return serveEnvelope(envelope, "miss");
    } catch {
      // §3.1: any upstream failure (network, timeout, non-2xx,
      // cross-host redirect) answers 502 and the client falls back to
      // its direct chain.
      return errorResponse(502, "upstream_failed");
    }
  });
}