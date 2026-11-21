/**
 * The KV seam: per-instance memory semantics (TTLs, counters, prefix
 * scan) and the Upstash REST wire shape (command JSON over fetch,
 * bearer auth -- never the token in the URL).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKv } from "../src/kv";
import { freshEnv, mockFetch } from "./helpers";

beforeEach(() => {
  freshEnv();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("memory fallback (per-instance)", () => {
  it("round-trips values and expires them at the TTL", async () => {
    const kv = openKv(null, null);
    await kv.setTtl("k", "v", 10);
    expect(await kv.get("k")).toBe("v");
    vi.advanceTimersByTime(11_000);
    expect(await kv.get("k")).toBeNull();
  });

  it("incrWithTtl counts and arms the window exactly once", async () => {
    const kv = openKv(null, null);
    expect(await kv.incrWithTtl("c", 3600)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(await kv.incrWithTtl("c", 3600)).toBe(2); // TTL not refreshed
    vi.advanceTimersByTime(3_540_000); // past the first-armed window
    expect(await kv.incrWithTtl("c", 3600)).toBe(1); // fresh bucket value
  });

  it("keys() lists only live rows under the prefix", async () => {
    const kv = openKv(null, null);
    await kv.setTtl("peer:a", "1", 60);
    await kv.setTtl("peer:b", "2", 60);
    await kv.setTtl("block:c", "3", 60);
    vi.advanceTimersByTime(61_000);
    await kv.setTtl("peer:d", "4", 60);
    expect(await kv.keys("peer:")).toEqual(["peer:d"]);
  });

  it("del() removes rows", async () => {
    const kv = openKv(null, null);
    await kv.setTtl("k", "v", 60);
    await kv.del("k");
    expect(await kv.get("k")).toBeNull();
  });
});

describe("Upstash REST", () => {
  it("speaks command JSON with bearer auth", async () => {
    const requests: Array<{ url: string; auth: string | null; body: unknown }> = [];
    mockFetch(async (url, init) => {
      requests.push({
        url: url.href,
        auth: ((init?.headers ?? {}) as Record<string, string>).authorization ?? null,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ result: "OK" }));
    });
    const kv = openKv("https://kv.example.org", "test-token-only");
    await kv.setTtl("block:bX", "PAYLOAD", 120);
    expect(requests[0]).toEqual({
      url: "https://kv.example.org/", // URL normalizes the base
      auth: "Bearer test-token-only",
      body: ["SET", "block:bX", "PAYLOAD", "EX", 120],
    });
  });

  it("pipelines INCR + EXPIRE NX and returns the counter", async () => {
    const bodies: unknown[] = [];
    mockFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify([{ result: 3 }, { result: true }]));
    });
    const kv = openKv("https://kv.example.org", "test-token-only");
    await expect(kv.incrWithTtl("rl:lookup:ip:1", 3600)).resolves.toBe(3);
    expect(bodies[0]).toEqual([
      ["INCR", "rl:lookup:ip:1"],
      ["EXPIRE", "rl:lookup:ip:1", 3600, "NX"],
    ]);
  });

  it("keys() SCANs from cursor 0 across pages (do/while, finding 1)", async () => {
    const bodies: unknown[] = [];
    let scan = 0;
    mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      // First SCAN returns a non-zero cursor + one key; the second
      // finishes the iteration. The pre-fix code never issued ANY scan
      // (cursor 0 !== "0" was false before the first call).
      scan += 1;
      return new Response(
        JSON.stringify(scan === 1 ? { result: ["17", ["peer:a"]] } : { result: ["0", ["peer:b"]] }),
      );
    });
    const kvInstance = openKv("https://kv.example.org", "test-token-only");
    await expect(kvInstance.keys("peer:")).resolves.toEqual(["peer:a", "peer:b"]);
    expect(bodies).toEqual([
      ["SCAN", "0", "MATCH", "peer:*", "COUNT", "256"],
      ["SCAN", "17", "MATCH", "peer:*", "COUNT", "256"],
    ]);
  });

  it("maps GET nulls to null and reports values verbatim", async () => {
    mockFetch(async () => new Response(JSON.stringify({ result: null })));
    const kv = openKv("https://kv.example.org", "test-token-only");
    await expect(kv.get("absent")).resolves.toBeNull();
  });
});