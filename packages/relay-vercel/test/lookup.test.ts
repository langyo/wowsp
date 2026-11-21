/**
 * /api/lookup/fetch behavior: the allowlist gate, the miss -> store ->
 * hit cycle, budgets, POST forwarding, redirect policy, caps and the
 * peer pull (contract §3, §5.4). All fetches are mocked; the KV is the
 * per-instance memory store.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { handleLookup, gateUpstreamUrl } from "../src/lookup";
import { canonicalRequestLine, cidOfRequest } from "../src/policy";
import { freshEnv, get, jsonOf, mockFetch, post } from "./helpers";

const SHIPS_URL = "https://vortex.wowsgame.cn/api/accounts/2035526744/ships/pvp/";
const UPSTREAM_DOC = JSON.stringify({ data: [{ ship_id: 4182980208, battles: 100 }] });

beforeEach(() => {
  // Sync off + no upstream list keeps every test's fetch surface local;
  // the peer-pull suite re-enables sync explicitly.
  freshEnv({ PEERS_SYNC: "false", PEERS_UPSTREAM: "" });
});

function lookupRequest(url: string): Request {
  return get(`/api/lookup/fetch?url=${encodeURIComponent(url)}`);
}

describe("gateUpstreamUrl (§3.1/§3.2)", () => {
  it("accepts allowlisted https URLs", () => {
    expect(gateUpstreamUrl(SHIPS_URL)).toMatchObject({ ok: true });
  });
  it("rejects http:// with 403 forbidden_host", () => {
    expect(gateUpstreamUrl("http://vortex.wowsgame.cn/api/accounts/1/")).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_host",
    });
  });
  it("rejects non-allowlist hosts with 403 forbidden_host", () => {
    expect(gateUpstreamUrl("https://evil.example.com/api/")).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_host",
    });
  });
  it("rejects IP-literal hosts (not on the allowlist)", () => {
    expect(gateUpstreamUrl("https://192.0.2.10/api/accounts/1/")).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_host",
    });
  });
  it("rejects userinfo with 400 invalid_url", () => {
    expect(gateUpstreamUrl("https://user:pass@vortex.wowsgame.cn/api/accounts/1/")).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_url",
    });
  });
  it("rejects an explicit port with 400 invalid_url", () => {
    expect(gateUpstreamUrl("https://vortex.wowsgame.cn:8443/api/accounts/1/")).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_url",
    });
  });
  it("rejects garbage with 400 invalid_url", () => {
    expect(gateUpstreamUrl("not a url")).toMatchObject({ ok: false, status: 400, code: "invalid_url" });
  });
});

describe("miss -> store -> hit (§3.3/§3.4)", () => {
  it("serves a miss, stores, then serves a hit without refetching", async () => {
    const { calls } = mockFetch(() => new Response(UPSTREAM_DOC, { headers: { "content-type": "application/json" } }));
    const first = await handleLookup(lookupRequest(SHIPS_URL));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-wowsp-cache")).toBe("miss");
    expect(first.headers.get("age")).toBe("0");
    expect(first.headers.get("cache-control")).toBe("public, max-age=120"); // §3.3 ships row
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect(await first.text()).toBe(UPSTREAM_DOC);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.headers).toMatchObject({ "user-agent": expect.stringContaining("Mozilla/5.0") });

    const second = await handleLookup(lookupRequest(SHIPS_URL));
    expect(second.headers.get("x-wowsp-cache")).toBe("hit");
    expect(await second.text()).toBe(UPSTREAM_DOC);
    expect(calls).toHaveLength(1); // no second upstream fetch
  });

  it("keys the cache on the full URL including query", async () => {
    const { calls } = mockFetch(() => new Response("{}", { headers: { "content-type": "application/json" } }));
    await handleLookup(lookupRequest("https://api.worldofwarships.asia/wows/account/list/?application_id=a&search=x"));
    await handleLookup(lookupRequest("https://api.worldofwarships.asia/wows/account/list/?application_id=a&search=y"));
    expect(calls).toHaveLength(2);
  });
});

describe("POST forwarding (§3.1)", () => {
  it("forwards the body verbatim and folds its hash into the CID", async () => {
    const { calls } = mockFetch(() => new Response("{}", { headers: { "content-type": "application/json" } }));
    const url = "https://v3-api.wows.shinoaki.com/api/ban/cn";
    const request = post(`/api/lookup/fetch?url=${encodeURIComponent(url)}`, "[2035526744]", {
      "content-type": "application/json",
    });
    const response = await handleLookup(request);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].bodyText).toBe("[2035526744]");
    const initHeaders = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(initHeaders["content-type"]).toBe("application/json");
    expect(calls[0].init?.method).toBe("POST");

    // Same URL, different body -> different CID -> upstream again.
    await handleLookup(post(`/api/lookup/fetch?url=${encodeURIComponent(url)}`, "[42]", {
      "content-type": "application/json",
    }));
    expect(calls).toHaveLength(2);
  });

  it("refuses POST bodies over 8 KiB", async () => {
    const big = "x".repeat(8193);
    const url = "https://v3-api.wows.shinoaki.com/api/ban/cn";
    const response = await handleLookup(post(`/api/lookup/fetch?url=${encodeURIComponent(url)}`, big));
    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toEqual({ error: "body_too_large" });
  });
});

describe("upstream failures (§3.1)", () => {
  it("answers 502 upstream_failed on network errors", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    const response = await handleLookup(lookupRequest(SHIPS_URL));
    expect(response.status).toBe(502);
    expect(await jsonOf(response)).toEqual({ error: "upstream_failed" });
  });
  it("answers 502 upstream_failed on non-2xx upstream statuses", async () => {
    mockFetch(() => new Response("nope", { status: 503 }));
    const response = await handleLookup(lookupRequest(SHIPS_URL));
    expect(response.status).toBe(502);
  });
  it("answers 502 on cross-host redirects (§3.2)", async () => {
    mockFetch((url) =>
      url.hostname === "vortex.wowsgame.cn"
        ? new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } })
        : new Response("never", { status: 200 }),
    );
    const response = await handleLookup(lookupRequest(SHIPS_URL));
    expect(response.status).toBe(502);
    expect(await jsonOf(response)).toEqual({ error: "upstream_failed" });
  });
  it("follows same-host redirects to the document", async () => {
    const { calls } = mockFetch((url) =>
      url.pathname.endsWith("/pvp")
        ? new Response(null, { status: 308, headers: { location: url.href + "/" } })
        : new Response(UPSTREAM_DOC, { headers: { "content-type": "application/json" } }),
    );
    const response = await handleLookup(lookupRequest("https://vortex.wowsgame.cn/api/accounts/2035526744/ships/pvp"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wowsp-cache")).toBe("miss");
    expect(calls).toHaveLength(2);
    // The stored CID belongs to the ORIGINAL request line (pvp, no
    // trailing slash), so the same request now hits the cache.
    const block = await handleLookup(lookupRequest("https://vortex.wowsgame.cn/api/accounts/2035526744/ships/pvp"));
    expect(block.headers.get("x-wowsp-cache")).toBe("hit");
  });
});

describe("per-IP hourly budget (§3.5)", () => {
  it("trips 429 with retry-after past the override", async () => {
    freshEnv({ PEERS_SYNC: "false", PEERS_UPSTREAM: "", LOOKUP_RATE_PER_HOUR: "2" });
    const requests = [
      handleLookup(lookupRequest(SHIPS_URL)),
      handleLookup(get("/api/lookup/fetch?url=not+a+url")), // budget burns on any request
    ];
    await Promise.all(requests);
    const third = await handleLookup(lookupRequest(SHIPS_URL));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await jsonOf(third)).toEqual({ error: "rate_limited" });
  });
});

describe("8 MiB cap (§3.1)", () => {
  it("passes over-cap bodies through UNCACHED", async () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    oversized.fill(65); // "A"
    const { calls } = mockFetch(() => new Response(oversized, { headers: { "content-type": "application/octet-stream" } }));
    const response = await handleLookup(lookupRequest("https://api.wows-numbers.com/personal/rating/expected/json/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wowsp-cache")).toBe("miss");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const served = new Uint8Array(await response.arrayBuffer());
    expect(served.byteLength).toBe(8 * 1024 * 1024 + 1); // streamed once, in full
    expect(calls).toHaveLength(1);
    // Nothing was stored: the next request hits upstream again.
    await handleLookup(lookupRequest("https://api.wows-numbers.com/personal/rating/expected/json/"));
    expect(calls).toHaveLength(2);
  });
});

describe("peer pull (§5.4)", () => {
  it("serves a verified peer row and never calls the upstream", async () => {
    freshEnv({ PEERS_SYNC: "true", PEERS_UPSTREAM: "" });
    const line = canonicalRequestLine("GET", SHIPS_URL, null);
    const cid = await cidOfRequest(line);
    const envelope = {
      v: 1,
      status: 200,
      contentType: "application/json",
      bodyB64: btoa(UPSTREAM_DOC),
      fetchedAt: Math.floor(Date.now() / 1000),
      ttl: 120,
      upstream: "vortex.wowsgame.cn",
    };
    // Seed the own registry with one lookup-capable peer.
    const { openKv } = await import("../src/kv");
    const kv = openKv(null, null);
    await kv.setTtl(
      "peer:https://peer.example.org",
      JSON.stringify({
        v: 1,
        url: "https://peer.example.org",
        capabilities: { gateway: true, lookup: true, peers: true, blocks: true },
        role: "community",
        nodeId: "0123456789abcdef0123456789abcdef",
        addedAt: 1,
        lastSeenAt: 2,
        notice: null,
        private: false,
      }),
      172_800,
    );
    const { calls } = mockFetch((url) => {
      if (url.href === `https://peer.example.org/api/blocks/${cid}`) {
        return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected fetch " + url.href);
    });
    const response = await handleLookup(lookupRequest(SHIPS_URL));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wowsp-cache")).toBe("peer-hit");
    expect(await response.text()).toBe(UPSTREAM_DOC);
    expect(calls).toHaveLength(1); // only the peer block fetch

    // The pulled row is stored locally: a plain hit follows.
    const cached = await handleLookup(lookupRequest(SHIPS_URL));
    expect(cached.headers.get("x-wowsp-cache")).toBe("hit");
  });

  it("skips peers that are not lookup-capable", async () => {
    freshEnv({ PEERS_SYNC: "true", PEERS_UPSTREAM: "" });
    const { openKv } = await import("../src/kv");
    const kv = openKv(null, null);
    await kv.setTtl(
      "peer:https://gateway-only.example.org",
      JSON.stringify({
        v: 1,
        url: "https://gateway-only.example.org",
        capabilities: { gateway: true, lookup: false, peers: false, blocks: false },
        role: "community",
        nodeId: "0123456789abcdef0123456789abcdef",
        addedAt: 1,
        lastSeenAt: 2,
        notice: null,
        private: false,
      }),
      172_800,
    );
    const { calls } = mockFetch(() => new Response(UPSTREAM_DOC, { headers: { "content-type": "application/json" } }));
    const response = await handleLookup(lookupRequest(SHIPS_URL));
    expect(response.headers.get("x-wowsp-cache")).toBe("miss"); // fell through to upstream
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SHIPS_URL);
  });
});

describe("miscellaneous routing", () => {
  it("answers 405 for PUT", async () => {
    const response = await handleLookup(new Request("https://x/api/lookup/fetch", { method: "PUT" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
  });
  it("answers OPTIONS preflight", async () => {
    const response = await handleLookup(new Request("https://x/api/lookup/fetch", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
  it("answers 400 when the url param is missing", async () => {
    const response = await handleLookup(get("/api/lookup/fetch"));
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "missing_url" });
  });
});
