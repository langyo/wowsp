/**
 * `GET /api/blocks/<cid>` (+ `/raw`, + the `/ipfs/<cid>` alias) --
 * the content-addressed store (contract §4).
 *
 * Rows only ever enter the store through src/lookup.ts (own upstream
 * fetch or verified peer pull), where the CID is recomputed from the
 * canonical request line before the write -- §4.2's verification is an
 * ingress property of this adapter, and serving re-checks the row
 * shape + grace window so a corrupt or ancient row reads as unknown.
 */

import { readConfig } from "./config";
import { base64ToBytes, envelopeAge, envelopeRemaining, parseEnvelope, withinGrace, type Envelope } from "./envelope";
import { errorResponse, guarded, methodNotAllowed, preflight } from "./http";
import { openKv } from "./kv";
import { CID_SPELLING_RE } from "./policy";

interface LoadedBlock {
  envelope: Envelope;
  raw: string;
}

async function loadBlock(cid: string): Promise<LoadedBlock | null> {
  const cfg = readConfig();
  const kv = openKv(cfg.kvRestUrl, cfg.kvRestToken);
  const raw = await kv.get(`block:${cid}`).catch(() => null);
  const envelope = parseEnvelope(raw);
  if (envelope === null) return null;
  if (!withinGrace(envelope)) return null; // TTL + 24 h past: as good as absent (§4.3)
  return { envelope, raw: raw as string };
}

type CidPath = { kind: "ok"; cid: string } | { kind: "missing" } | { kind: "malformed" };

/**
 * Pull the <cid> path segment out of /api/blocks/<cid>... or /ipfs/<cid>.
 * Malformed percent-escapes make decodeURIComponent THROW -- surfaced
 * as `malformed` so the routes answer 400 invalid_cid, not a 500.
 */
function cidFromPath(pathname: string, ipfsAlias?: "ipfs"): CidPath {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const segment = ipfsAlias === "ipfs" ? segments[1] : segments[2];
  if (ipfsAlias === "ipfs") {
    if (segments.length !== 2 || segments[0] !== "ipfs") return { kind: "missing" };
  } else if (segments.length < 3 || segments[0] !== "api" || segments[1] !== "blocks") {
    return { kind: "missing" };
  }
  if (segment === undefined) return { kind: "missing" };
  try {
    return { kind: "ok", cid: decodeURIComponent(segment) };
  } catch {
    return { kind: "malformed" };
  }
}

/** `GET /api/blocks/<cid>` -- the envelope JSON (404 unknown, §4.2). */
export async function handleBlockEnvelope(request: Request): Promise<Response> {
  return guarded(async () => {
    if (request.method === "OPTIONS") return preflight();
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    const path = cidFromPath(new URL(request.url).pathname);
    if (path.kind === "missing") return errorResponse(404, "not_found");
    if (path.kind === "malformed") return errorResponse(400, "invalid_cid");
    const cid = path.cid;
    if (!CID_SPELLING_RE.test(cid)) return errorResponse(400, "invalid_cid");
    const block = await loadBlock(cid);
    if (block === null) return errorResponse(404, "not_found");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": `public, max-age=${envelopeRemaining(block.envelope)}`,
      "x-wowsp-cache": "hit",
      age: String(envelopeAge(block.envelope)),
      "access-control-allow-origin": "*",
    };
    return new Response(block.raw, { status: 200, headers });
  });
}

/** `GET /api/blocks/<cid>/raw` and the `/ipfs/<cid>` alias (§4.2). */
export async function handleBlockRaw(request: Request, ipfsAlias?: "ipfs"): Promise<Response> {
  return guarded(async () => {
    if (request.method === "OPTIONS") return preflight();
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    const path = cidFromPath(new URL(request.url).pathname, ipfsAlias);
    if (path.kind === "missing") return errorResponse(404, "not_found");
    if (path.kind === "malformed") return errorResponse(400, "invalid_cid");
    const cid = path.cid;
    if (!CID_SPELLING_RE.test(cid)) return errorResponse(400, "invalid_cid");
    const block = await loadBlock(cid);
    if (block === null) return errorResponse(404, "not_found");
    const headers: Record<string, string> = {
      "content-type": block.envelope.contentType || "application/json",
      "cache-control": `public, max-age=${envelopeRemaining(block.envelope)}`,
      "x-wowsp-cache": "hit",
      age: String(envelopeAge(block.envelope)),
      "access-control-allow-origin": "*",
    };
    return new Response(base64ToBytes(block.envelope.bodyB64) as unknown as BodyInit, { status: 200, headers });
  });
}