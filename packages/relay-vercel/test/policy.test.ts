/**
 * Policy vectors -- the fixture IS the test data (test/policy.fixture.json
 * is shared with the Rust relay-core implementation so both sides can be
 * cross-checked against the same bytes; docs/en/designs/cache-mesh.md
 * §3.3 "pinned by a shared fixture test").
 */

import { describe, expect, it } from "vitest";
import fixture from "./policy.fixture.json";
import {
  ALLOWLIST,
  CID_SPELLING_RE,
  base58btcEncode,
  canonicalRequestLine,
  cidOfRequest,
  cidVerify,
  classifyTtl,
} from "../src/policy";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGIT_OF = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)]));

/** Independent base58btc decoder (tests must not trust the encoder). */
function decode58(cid: string): Uint8Array {
  let value = 0n;
  for (const char of cid) {
    const digit = DIGIT_OF.get(char);
    if (digit === undefined) throw new Error("non-base58 char in " + cid);
    value = value * 58n + digit;
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return new Uint8Array(bytes.reverse());
}

describe("canonical request lines (fixture)", () => {
  for (const vector of fixture.canonicalLines) {
    it(`${vector.method} ${vector.url}`, () => {
      expect(canonicalRequestLine(vector.method, vector.url, vector.bodySha256)).toBe(vector.expected);
    });
  }
  it("omits the third field when there is no body", () => {
    expect(canonicalRequestLine("GET", "https://vortex.wowsgame.cn/x", null)).toBe(
      "GET https://vortex.wowsgame.cn/x",
    );
  });
  it("spells the body hash as a space-separated bare-hex third field", () => {
    // The cross-implementation spelling pinned by the PR #2065 /
    // relay-core cross-check: "POST <url> <64-hex>" -- the §3.3 bracket
    // fragment was optional-field notation, never literal characters.
    expect(canonicalRequestLine("POST", "https://v3-api.wows.shinoaki.com/api/ban/cn", "aa".repeat(32))).toBe(
      `POST https://v3-api.wows.shinoaki.com/api/ban/cn ${"aa".repeat(32)}`,
    );
  });
});

describe("CIDs (fixture + independent layout verification)", () => {
  for (const vector of fixture.cids) {
    it(vector.expectedCid, async () => {
      // The fixture drives the expectation; the implementation must
      // reproduce it byte-for-byte.
      await expect(cidOfRequest(vector.canonicalLine)).resolves.toBe(vector.expectedCid);
      // Independent structural check: version 0x01, raw codec 0x55,
      // sha2-256 multihash 0x12 0x20 || sha256(line).
      const bytes = decode58(vector.expectedCid);
      expect(bytes).toHaveLength(36);
      expect([...bytes.subarray(0, 4)]).toEqual([0x01, 0x55, 0x12, 0x20]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(vector.canonicalLine)));
      expect(Buffer.compare(Buffer.from(bytes.subarray(4)), Buffer.from(digest))).toBe(0);
      // cidVerify agrees with itself and rejects a wrong line.
      await expect(cidVerify(vector.expectedCid, vector.canonicalLine)).resolves.toBe(true);
      await expect(cidVerify(vector.expectedCid, vector.canonicalLine + "x")).resolves.toBe(false);
    });
  }
  it("is deterministic across calls", async () => {
    const line = fixture.cids[0].canonicalLine;
    await expect(cidOfRequest(line)).resolves.toBe(await cidOfRequest(line));
  });
});

describe("CID spelling", () => {
  it("accepts the fixture spellings", () => {
    for (const vector of fixture.cids) expect(CID_SPELLING_RE.test(vector.expectedCid)).toBe(true);
  });
  it("rejects non-base58btc characters (0 O I l)", () => {
    expect(CID_SPELLING_RE.test("b" + "0".repeat(47))).toBe(false);
    expect(CID_SPELLING_RE.test("b" + "O".repeat(47))).toBe(false);
    expect(CID_SPELLING_RE.test("b" + "I".repeat(47))).toBe(false);
    expect(CID_SPELLING_RE.test("b" + "l".repeat(47))).toBe(false);
  });
  it("rejects wrong lengths and prefixes", () => {
    expect(CID_SPELLING_RE.test("b" + "a".repeat(10))).toBe(false);
    expect(CID_SPELLING_RE.test("b" + "a".repeat(80))).toBe(false);
    expect(CID_SPELLING_RE.test("a" + "a".repeat(47))).toBe(false);
  });
  it("base58btc keeps the known multibase vector", () => {
    expect(base58btcEncode(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
  });
});

describe("TTL classification (fixture: every §3.3 row + defaults)", () => {
  for (const vector of fixture.ttls) {
    it(`${vector.host}${vector.path} -> ${vector.expected}`, () => {
      expect(classifyTtl(vector.host, vector.path)).toBe(vector.expected);
    });
  }
  it("is host-case-insensitive and path-normalizing", () => {
    expect(classifyTtl("VORTEX.WOWSGAME.CN", "api/accounts/1/ships/pvp/")).toBe(120);
  });
});

describe("allowlist", () => {
  it("is exactly the 13 §3.2 stats hosts", () => {
    expect(ALLOWLIST.size).toBe(13);
    for (const host of [
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
    ]) {
      expect(ALLOWLIST.has(host)).toBe(true);
    }
    expect(ALLOWLIST.has("wowsgame.cn")).toBe(false);
    expect(ALLOWLIST.has("evil.example.com")).toBe(false);
  });
});
