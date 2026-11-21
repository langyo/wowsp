/**
 * The stored envelope (contract §3.3 + the relay-core PR #2067 addition):
 * what a block row contains and how it is (de)serialized. Envelope JSON
 * is also the /api/blocks wire body (§4.2) and the on-disk file content
 * for native deployments.
 *
 * The OPTIONAL `line` field carries the canonical request line the row
 * was fetched under (camelCase JSON key, exactly as relay-core spells
 * it). Own writes always include it; peer-pulled rows are only trusted
 * when it is present and hashes to the requested CID (src/lookup.ts,
 * fail closed) -- that is the §4.2 content verification.
 */

/** The §3.3 envelope. `v` is a schema version, not the release version. */
export interface Envelope {
  v: 1;
  /** Upstream HTTP status (only 2xx documents are ever cached). */
  status: number;
  /** Original content-type, default application/json (§3.4). */
  contentType: string;
  /** Base64 of the upstream body bytes. */
  bodyB64: string;
  /** Epoch seconds the document was fetched. */
  fetchedAt: number;
  /** §3.3 TTL in seconds. */
  ttl: number;
  /** The allowlisted host the document came from (hostname only). */
  upstream: string;
  /**
   * Canonical request line (relay-core PR #2067): present on rows this
   * node wrote itself, absent on foreign rows from older nodes. null
   * means "not carried".
   */
  line: string | null;
}

/** Current epoch seconds (the mesh speaks seconds everywhere). */
export function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Serialize with a fixed key order (stable CIDs/ETags). `line` is only
 * emitted when carried, matching the optional wire field.
 */
export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify({
    v: envelope.v,
    status: envelope.status,
    contentType: envelope.contentType,
    bodyB64: envelope.bodyB64,
    fetchedAt: envelope.fetchedAt,
    ttl: envelope.ttl,
    upstream: envelope.upstream,
    ...(envelope.line !== null ? { line: envelope.line } : {}),
  });
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Sanity ceiling for the carried line: canonical lines are short URLs. */
const LINE_MAX = 8192;

/**
 * Parse + shape-validate a stored/received envelope. Returns `null`
 * for anything that is not a well-formed v1 envelope -- callers treat
 * that as "unknown block" (a corrupt row is dropped, never served).
 * The body must actually DECODE: a regex-shaped but undecodable
 * bodyB64 (e.g. "A") would otherwise 500 every later serve.
 */
export function parseEnvelope(raw: string | null | undefined): Envelope | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const e = parsed as Record<string, unknown>;
  if (e.v !== 1) return null;
  if (typeof e.status !== "number" || !Number.isFinite(e.status)) return null;
  if (typeof e.contentType !== "string") return null;
  if (typeof e.bodyB64 !== "string" || !BASE64_RE.test(e.bodyB64)) return null;
  try {
    atob(e.bodyB64);
  } catch {
    return null; // shape-right but undecodable -- not a storable row
  }
  if (typeof e.fetchedAt !== "number" || !Number.isFinite(e.fetchedAt)) return null;
  if (typeof e.ttl !== "number" || !Number.isFinite(e.ttl) || e.ttl <= 0) return null;
  if (typeof e.upstream !== "string") return null;
  return {
    v: 1,
    status: e.status,
    contentType: e.contentType,
    bodyB64: e.bodyB64,
    fetchedAt: e.fetchedAt,
    ttl: e.ttl,
    upstream: e.upstream,
    line: typeof e.line === "string" && e.line.length > 0 && e.line.length <= LINE_MAX ? e.line : null,
  };
}

/** Seconds since the document was fetched. */
export function envelopeAge(envelope: Envelope): number {
  return Math.max(0, epochSeconds() - envelope.fetchedAt);
}

/** Remaining freshness under the envelope TTL (>= 0). */
export function envelopeRemaining(envelope: Envelope): number {
  return Math.max(0, envelope.ttl - envelopeAge(envelope));
}

/** §4.3: rows live TTL + 24 h; past that a row is as good as absent. */
export function withinGrace(envelope: Envelope): boolean {
  return envelopeAge(envelope) <= envelope.ttl + 86_400;
}

/** Fresh = still inside its TTL (serves as a cache hit). */
export function envelopeFresh(envelope: Envelope): boolean {
  return envelopeAge(envelope) < envelope.ttl;
}

// ── base64, chunked so multi-megabyte bodies never blow the call stack ────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
