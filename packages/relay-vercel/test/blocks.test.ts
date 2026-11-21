/**
 * /api/blocks/<cid> (+/raw) and the /ipfs/<cid> alias (contract §4.2).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { handleBlockEnvelope, handleBlockRaw } from "../src/blocks";
import { parseEnvelope } from "../src/envelope";
import { handleLookup } from "../src/lookup";
import { canonicalRequestLine, cidOfRequest } from "../src/policy";
import { freshEnv, get, jsonOf, mockFetch } from "./helpers";

const SHIPS_URL = "https://vortex.wowsgame.cn/api/accounts/2035526744/ships/pvp/";
const DOC = JSON.stringify({ data: [{ battles: 42 }] });

async function prime(): Promise<string> {
  const cid = await cidOfRequest(canonicalRequestLine("GET", SHIPS_URL, null));
  return cid;
}

beforeEach(() => {
  freshEnv({ PEERS_SYNC: "false", PEERS_UPSTREAM: "" });
});

describe("after a lookup stores a block", () => {
  it("serves the envelope, the raw bytes and the /ipfs alias, 404s unknown", async () => {
    mockFetch(() => new Response(DOC, { headers: { "content-type": "application/json; charset=utf-8" } }));
    await handleLookup(get(`/api/lookup/fetch?url=${encodeURIComponent(SHIPS_URL)}`));
    const cid = await prime();

    const envelope = await handleBlockEnvelope(get(`/api/blocks/${cid}`));
    expect(envelope.status).toBe(200);
    expect(envelope.headers.get("content-type")).toBe("application/json");
    expect(envelope.headers.get("x-wowsp-cache")).toBe("hit");
    const parsed = await jsonOf<{ bodyB64: string; line: string | null; [key: string]: unknown }>(envelope);
    expect(parsed).toMatchObject({
      v: 1,
      status: 200,
      contentType: "application/json; charset=utf-8",
      ttl: 120,
      upstream: "vortex.wowsgame.cn",
    });
    // Own writes carry the canonical line (relay-core PR #2067).
    expect(parsed.line).toBe(`GET ${SHIPS_URL}`);
    expect(atob(parsed.bodyB64)).toBe(DOC);

    const raw = await handleBlockRaw(get(`/api/blocks/${cid}/raw`));
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await raw.text()).toBe(DOC);

    const ipfs = await handleBlockRaw(get(`/ipfs/${cid}`), "ipfs");
    expect(ipfs.status).toBe(200);
    expect(await ipfs.text()).toBe(DOC);
    expect(ipfs.headers.get("access-control-allow-origin")).toBe("*");

    const unknown = await handleBlockEnvelope(get("/api/blocks/" + "b".padEnd(48, "z")));
    expect(unknown.status).toBe(404);
    expect(await jsonOf(unknown)).toEqual({ error: "not_found" });
  });

  it("answers 400 (not 500) for malformed percent-escapes in the path", async () => {
    const response = await handleBlockEnvelope(get("/api/blocks/%zz"));
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "invalid_cid" });
    const raw = await handleBlockRaw(get("/api/blocks/%zz/raw"));
    expect(raw.status).toBe(400);
  });

  it("parseEnvelope rejects undecodable base64 and carries line", () => {
    const base = {
      v: 1,
      status: 200,
      contentType: "application/json",
      fetchedAt: 1,
      ttl: 60,
      upstream: "vortex.wowsgame.cn",
    };
    // Regex-shaped but undecodable ("A") must be refused (finding 4) --
    // a stored row like this would 500 every later serve.
    expect(parseEnvelope(JSON.stringify({ ...base, bodyB64: "A" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, bodyB64: "aGk=" }))).toMatchObject({
      bodyB64: "aGk=",
      line: null, // field absent -> null, not undefined
    });
    expect(parseEnvelope(JSON.stringify({ ...base, bodyB64: "aGk=", line: "GET https://x/" }))).toMatchObject({
      line: "GET https://x/",
    });
  });

  it("answers 404 for a /raw of an unknown cid", async () => {
    const unknownCid = "b" + "z".repeat(47); // valid base58btc spelling, never stored
    const response = await handleBlockRaw(get(`/api/blocks/${unknownCid}/raw`));
    expect(response.status).toBe(404);
  });

  it("answers 400 for malformed CIDs (charset/length)", async () => {
    for (const bad of ["0OIlbadcharsetcidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "b2short", "b" + "z".repeat(200)]) {
      const response = await handleBlockEnvelope(get(`/api/blocks/${encodeURIComponent(bad)}`));
      expect(response.status).toBe(400);
      expect(await jsonOf(response)).toEqual({ error: "invalid_cid" });
    }
  });

  it("answers 405 for POST", async () => {
    const response = await handleBlockEnvelope(new Request("https://x/api/blocks/btest", { method: "POST" }));
    expect(response.status).toBe(405);
  });
});