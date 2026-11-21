/**
 * The policy core mirrored from relay-core (cache-mesh wave A, Rust):
 * allowlist, TTL classification, canonical request lines and CIDs.
 *
 * Contract: docs/en/designs/cache-mesh.md §3.2 (allowlist), §3.3 (cache
 * key + TTL table), §4.1 (CID scheme). This module is pinned to
 * test/policy.fixture.json, which is shared with the Rust relay-core so
 * the two implementations can be cross-checked: change the policy,
 * change the fixture, and the other side's CI fails until it agrees.
 */

/**
 * The stats-family host allowlist (contract §3.2) -- exactly the 13
 * hosts of `res/config/upstream-endpoints.json`'s stats family. The
 * lookup proxy is allowlist-only; it is never an open proxy (§8).
 */
export const ALLOWLIST: ReadonlySet<string> = new Set([
  "api.korabli.su",
  "api.worldofwarships.eu",
  "api.worldofwarships.com",
  "api.worldofwarships.asia",
  "vortex.korabli.su",
  "vortex.worldofwarships.eu",
  "vortex.worldofwarships.com",
  "vortex.worldofwarships.asia",
  "vortex.wowsgame.cn",
  "clans.wowsgame.cn",
  "api.wows-numbers.com",
  "v3-api.wows.shinoaki.com",
  "api.wows.yuyuko.dev",
]);

/**
 * The browser-shaped User-Agent the app itself sends -- CN WAFs reject
 * non-browser UAs (contract §3.1). Mirrors `BROWSER_UA` in the
 * `wg_api_cn` transport of the desktop app (relay-core re-exports the
 * same string for the Rust side).
 */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Default TTL for allowlisted hosts no table row matches (§3.3). */
export const DEFAULT_TTL_SECONDS = 300;

// §3.3 path-shape matchers, kept regex-literal so the fixture vectors
// read one-to-one against the contract table.
const VORTEX_ACCOUNT_RE = /^\/api\/accounts\/\d+\/?$/;
const VORTEX_SHIPS_RE = /^\/api\/accounts\/\d+\/ships(?:\/|$)/;
const VORTEX_SEARCH_RE = /\/search\/|\/autocomplete(?:\/|$)/;
// The WG/Lesta public-API family -- matched as an exact host set, NOT a
// prefix: api.wows-numbers.com / api.wows.yuyuko.dev also start with
// "api." but belong to the 86400 s rows below.
const WG_API_HOSTS: ReadonlySet<string> = new Set([
  "api.korabli.su",
  "api.worldofwarships.eu",
  "api.worldofwarships.com",
  "api.worldofwarships.asia",
]);
const WG_ACCOUNT_RE = /^\/wows\/account(?:\/|$)/;
const WG_CLANS_RE = /^\/wows\/clans(?:\/|$)/;
const WG_SEASONS_RE = /^\/wows\/seasons(?:\/|$)/;
const WG_ENCYCLOPEDIA_RE = /^\/wows\/encyclopedia(?:\/|$)/;

/**
 * TTL classification (contract §3.3): a pure function of host + path.
 * Mirrors `relay-core::lookup`; every table row plus the default is
 * pinned by a fixture vector.
 */
export function classifyTtl(host: string, path: string): number {
  const h = host.toLowerCase();
  const p = path.startsWith("/") ? path : "/" + path;
  if (h === "clans.wowsgame.cn") return 600;
  if (h.startsWith("vortex.")) {
    if (VORTEX_SEARCH_RE.test(p)) return 600;
    if (VORTEX_ACCOUNT_RE.test(p)) return 120;
    if (VORTEX_SHIPS_RE.test(p)) return 120;
    return DEFAULT_TTL_SECONDS;
  }
  if (WG_API_HOSTS.has(h)) {
    if (WG_ACCOUNT_RE.test(p)) return 120;
    if (WG_CLANS_RE.test(p) || WG_SEASONS_RE.test(p)) return 600;
    if (WG_ENCYCLOPEDIA_RE.test(p)) return 86_400;
    return DEFAULT_TTL_SECONDS;
  }
  // wows-numbers expected values + the yuyuko/shinoaki ban list are the
  // slow-moving documents (§3.3 rows 7-8): one TTL per host.
  if (h === "api.wows-numbers.com") return 86_400;
  if (h === "v3-api.wows.shinoaki.com" || h === "api.wows.yuyuko.dev") return 86_400;
  return DEFAULT_TTL_SECONDS;
}

/**
 * The canonical request line (contract §3.3, spelling pinned by the
 * cross-implementation cross-check of PR #2065 / relay-core): requests
 * WITHOUT a body are `"<METHOD> <url>"`; requests WITH a body carry
 * the sha256 of the forwarded body as a THIRD SPACE-SEPARATED bare-hex
 * field: `"POST <url> <64-lowercase-hex>"`. (The bracket fragment in
 * the original §3.3 wording was optional-field notation, not literal
 * -- the docs wave amends the contract to this space-separated form.)
 *
 * The url is the ABSOLUTE URL STRING EXACTLY AS THE CLIENT SUPPLIED it
 * in the `url=` query parameter (after one round of query decoding) --
 * no re-normalization. This choice is deliberate and fixture-pinned so
 * the Rust relay-core can byte-match it: given the same input string,
 * both sides produce the same line, hence the same CID.
 */
export function canonicalRequestLine(method: string, url: string, bodySha256: string | null): string {
  const m = method.toUpperCase();
  return bodySha256 === null ? `${m} ${url}` : `${m} ${url} ${bodySha256}`;
}

/** Hex sha256 of a byte array (crypto.subtle under the hood). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** base58btc alphabet (IPFS spelling, contract §4.1): no 0 O I l. */
const BASE58BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Hand-rolled base58btc encoder -- the Bitcoin/IPFS alphabet. */
export function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zero bytes: each encodes to '1' (Bitcoin convention;
  // a CIDv1 never starts with 0x00 but the routine stays general).
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // BigInt division over the whole payload.
  let value = 0n;
  for (const byte of bytes.subarray(zeros)) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58BTC_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return "1".repeat(zeros) + encoded;
}

/** Charset + shape check for a CID as spelled in a URL (§4.1). */
export const CID_SPELLING_RE = /^b[1-9A-HJ-NP-Za-km-z]{39,59}$/;

/**
 * The CID of a canonical request line (contract §4.1):
 *
 * ```
 * cid = CIDv1(raw, sha2-256)      // base58btc spelling in URLs
 *     = base58btc(0x01 || 0x55 || 0x12 0x20 || sha256(line))
 * ```
 *
 * version varint 0x01, raw codec varint 0x55, sha2-256 multihash
 * (0x12 0x20 || digest) -- the standard IPFS CID layout for raw
 * bytes, so a wowsp block store is addressable by the same CIDs an
 * IPFS node would produce for the same content.
 */
export async function cidOfRequest(canonicalLine: string): Promise<string> {
  const lineBytes = new TextEncoder().encode(canonicalLine);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", lineBytes as unknown as ArrayBuffer));
  // version || codec || multihash prefix (0x12 sha2-256, 0x20 32 bytes)
  const cidBytes = new Uint8Array(2 + 2 + digest.length);
  cidBytes[0] = 0x01;
  cidBytes[1] = 0x55;
  cidBytes[2] = 0x12;
  cidBytes[3] = 0x20;
  cidBytes.set(digest, 4);
  return base58btcEncode(cidBytes);
}

/**
 * Recompute-and-compare (contract §4.2: a served/stored block is
 * verified against the request line before it is trusted). Used at
 * every ingress point that stores a block (own upstream fetch and peer
 * pull) so a mangled line/cid pair can never enter the store.
 */
export async function cidVerify(cid: string, canonicalLine: string): Promise<boolean> {
  if (!CID_SPELLING_RE.test(cid)) return false;
  const expected = await cidOfRequest(canonicalLine);
  // String compare is fine here: CIDs are public addresses, not secrets.
  return expected === cid;
}