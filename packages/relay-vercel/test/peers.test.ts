/**
 * /api/peers + /api/peers/announce (contract §5): the merged broadcast
 * list, the liveness-checked handshake, the shape gates and budgets.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { handleAnnounce, handlePeersList } from "../src/peers";
import { openKv } from "../src/kv";
import { freshEnv, get, jsonOf, mockFetch, post } from "./helpers";

function seedPeerRow(kv: ReturnType<typeof openKv>, url: string, extra: Record<string, unknown> = {}): Promise<void> {
  return kv.setTtl(
    `peer:${url}`,
    JSON.stringify({
      v: 1,
      url,
      capabilities: { gateway: true, lookup: true, peers: true, blocks: true },
      role: "community",
      nodeId: "0123456789abcdef0123456789abcdef",
      addedAt: 100,
      lastSeenAt: 200,
      notice: null,
      private: false,
      ...extra,
    }),
    172_800,
  );
}

const HEALTH_OK = {
  ok: true,
  provider: "wowsp-gateway",
  name: "WoWSP Gateway",
  version: "0.5.0",
  notice: null,
  capabilities: { gateway: true, lookup: true, peers: true, blocks: true },
  node: { id: "fedcba9876543210fedcba9876543210", role: "community", sync: true, peersUpstream: null },
};

beforeEach(() => {
  freshEnv({ PEERS_UPSTREAM: "" });
});

describe("announce handshake (§5.2)", () => {
  it("lists a live wowsp node and refreshes on re-announce", async () => {
    const { calls } = mockFetch((url) => {
      expect(url.href).toBe("https://peer.example.org/api/health");
      return new Response(JSON.stringify(HEALTH_OK), { headers: { "content-type": "application/json" } });
    });
    const response = await handleAnnounce(
      post("/api/peers/announce", JSON.stringify({ url: "https://peer.example.org", contact: "XX legion node" })),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ ok: true, listed: true });
    expect(calls).toHaveLength(1);

    const list = await handlePeersList(get("/api/peers"));
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("public, max-age=60");
    expect(list.headers.get("access-control-allow-origin")).toBe("*");
    const body = await jsonOf(list);
    expect(body.v).toBe(1);
    expect(typeof body.generatedAt).toBe("number");
    expect(body.peers).toEqual([
      {
        url: "https://peer.example.org",
        capabilities: HEALTH_OK.capabilities,
        role: "community",
        nodeId: "fedcba9876543210fedcba9876543210",
        addedAt: expect.any(Number),
        lastSeenAt: expect.any(Number),
        notice: "XX legion node",
      },
    ]);
  });

  it("answers 200 listed:false when the callback is unreachable", async () => {
    mockFetch(() => {
      throw new Error("no route to host");
    });
    const response = await handleAnnounce(post("/api/peers/announce", JSON.stringify({ url: "https://peer.example.org" })));
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.ok).toBe(true);
    expect(body.listed).toBe(false);
    expect(typeof body.reason).toBe("string");
  });

  it("answers 200 listed:false for a foreign 200 (no capabilities)", async () => {
    mockFetch(() => new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }));
    const response = await handleAnnounce(post("/api/peers/announce", JSON.stringify({ url: "https://peer.example.org" })));
    expect(response.status).toBe(200);
    expect((await jsonOf(response)).listed).toBe(false);
  });

  it("closes the registry with 403 when announces are off (§5.2.5)", async () => {
    freshEnv({ PEERS_UPSTREAM: "", PEERS_ACCEPT_ANNOUNCES: "false" });
    const response = await handleAnnounce(post("/api/peers/announce", JSON.stringify({ url: "https://peer.example.org" })));
    expect(response.status).toBe(403);
    expect(await jsonOf(response)).toEqual({ error: "announces_disabled" });
  });

  it("trips the 10/hour/IP announce budget (§5.2.4)", async () => {
    mockFetch((url) => {
      if (url.href === "https://peer.example.org/api/health") {
        return new Response(JSON.stringify(HEALTH_OK));
      }
      throw new Error("unexpected " + url.href);
    });
    for (let i = 0; i < 10; i += 1) {
      const response = await handleAnnounce(post("/api/peers/announce", JSON.stringify({ url: "https://peer.example.org" })));
      expect(response.status).toBe(200);
    }
    const eleventh = await handleAnnounce(post("/api/peers/announce", JSON.stringify({ url: "https://peer.example.org" })));
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  const badUrls = [
    "http://peer.example.org", // not https
    "https://192.0.2.10", // IP literal
    "https://user:pass@peer.example.org", // userinfo
    "https://peer.example.org:8443", // explicit port
    "https://intranet", // dotless LAN name (§5.3)
    "https://peer.example.org/api", // not an origin
    "https://peer.example.org/?q=1", // query
    "javascript:alert(1)", // not http(s) at all
    "", // empty
    "x".repeat(300), // absurd length
  ];
  for (const url of badUrls) {
    it(`rejects the shape ${JSON.stringify(url).slice(0, 40)}`, async () => {
      const response = await handleAnnounce(post("/api/peers/announce", JSON.stringify({ url })));
      expect(response.status).toBe(400);
      expect(await jsonOf(response)).toEqual({ error: "invalid_url" });
    });
  }

  it("answers 400 for a non-JSON body", async () => {
    const response = await handleAnnounce(post("/api/peers/announce", "not json"));
    expect(response.status).toBe(400);
  });
});

describe("the list (§5.1)", () => {
  it("merges own rows with the upstream list, own rows winning", async () => {
    freshEnv({ PEERS_UPSTREAM: "https://official.example.org" });
    const kv = openKv(null, null);
    await seedPeerRow(kv, "https://shared.example.org", { role: "own-answer", lastSeenAt: 500 });
    const upstreamBody = {
      v: 1,
      generatedAt: 1,
      peers: [
        {
          url: "https://shared.example.org",
          capabilities: { lookup: true },
          role: "upstream-answer",
          nodeId: "aaa",
          addedAt: 1,
          lastSeenAt: 1,
          notice: null,
        },
        {
          url: "https://other.example.org",
          capabilities: { lookup: true },
          role: "community",
          nodeId: "bbb",
          addedAt: 1,
          lastSeenAt: 1,
          notice: null,
        },
      ],
    };
    let fetched = 0;
    mockFetch((url) => {
      if (url.href === "https://official.example.org/api/peers") {
        fetched += 1;
        return new Response(JSON.stringify(upstreamBody));
      }
      throw new Error("unexpected " + url.href);
    });
    const body = await jsonOf(await handlePeersList(get("/api/peers")));
    expect(fetched).toBe(1);
    expect(body.peers).toHaveLength(2);
    expect(body.peers[0]).toMatchObject({ url: "https://shared.example.org", role: "own-answer" }); // own wins
    expect(body.peers[1]).toMatchObject({ url: "https://other.example.org" });

    // The upstream list is cached <= 60 s: a second list call refetches nothing.
    await handlePeersList(get("/api/peers"));
    expect(fetched).toBe(1);
  });

  it("excludes private rows (§5.3)", async () => {
    const kv = openKv(null, null);
    await seedPeerRow(kv, "https://lan-node.example.org", { private: true });
    const body = await jsonOf(await handlePeersList(get("/api/peers")));
    expect(body.peers).toHaveLength(0);
  });

  it("revalidates with ETag -> 304", async () => {
    const kv = openKv(null, null);
    await seedPeerRow(kv, "https://peer.example.org");
    const first = await handlePeersList(get("/api/peers"));
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const revalidated = await handlePeersList(get("/api/peers", { "if-none-match": etag as string }));
    expect(revalidated.status).toBe(304);
  });

  it("caps the published list at 128, evicting the oldest lastSeenAt (§5.2.3)", async () => {
    const kv = openKv(null, null);
    for (let i = 0; i < 130; i += 1) {
      await seedPeerRow(kv, `https://peer${i}.example.org`, { lastSeenAt: 1000 + i });
    }
    const body = await jsonOf(await handlePeersList(get("/api/peers")));
    expect(body.peers).toHaveLength(128);
    const urls = body.peers.map((peer: { url: string }) => peer.url);
    expect(urls).not.toContain("https://peer0.example.org"); // oldest evicted
    expect(urls).toContain("https://peer129.example.org");
  });

  it("degrades to own rows when the upstream list is unreachable", async () => {
    freshEnv({ PEERS_UPSTREAM: "https://official.example.org" });
    const kv = openKv(null, null);
    await seedPeerRow(kv, "https://peer.example.org");
    mockFetch(() => {
      throw new Error("upstream list down");
    });
    const body = await jsonOf(await handlePeersList(get("/api/peers")));
    expect(body.peers).toHaveLength(1);
  });

  it("answers 405 for POST /api/peers", async () => {
    const response = await handlePeersList(post("/api/peers", "{}"));
    expect(response.status).toBe(405);
  });
});
