/**
 * /api/health (contract §2): the capability manifest.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { healthResponse } from "../src/health";
import { freshEnv, get, jsonOf } from "./helpers";

/** The §2 manifest shape the assertions destructure. */
interface HealthBody {
  ok: boolean;
  provider: string;
  name: string;
  version: string;
  notice: string | null;
  capabilities: { gateway: boolean; lookup: boolean; peers: boolean; blocks: boolean };
  node: { id: string; role: string; sync: boolean; peersUpstream: string | null };
}

beforeEach(() => freshEnv());

describe("manifest", () => {
  it("declares the HTTP-only subset (gateway false)", async () => {
    const body = await jsonOf<HealthBody>(healthResponse());
    expect(body).toMatchObject({
      ok: true,
      provider: "wowsp-gateway",
      name: "WoWSP Gateway (Vercel)",
      version: "0.0.0-dev",
      notice: null,
    });
    expect(body.capabilities).toEqual({ gateway: false, lookup: true, peers: true, blocks: true });
    expect(body.node.role).toBe("community"); // §2 default
    expect(body.node.sync).toBe(true); // §5.4 default
    expect(body.node.peersUpstream).toBe("https://wowsp.langyo.xyz"); // official default
    expect(body.node.id).toMatch(/^[0-9a-f]{32}$/); // §2: 32 lowercase hex
  });

  it("honors NODE_ID, NODE_ROLE, NOTICE and PEERS_SYNC overrides", async () => {
    freshEnv({
      NODE_ID: "0123456789abcdef0123456789abcdef",
      NODE_ROLE: "OFFICIAL",
      NOTICE: "test node",
      PEERS_SYNC: "false",
    });
    const body = await jsonOf<HealthBody>(healthResponse());
    expect(body.node.id).toBe("0123456789abcdef0123456789abcdef");
    expect(body.node.role).toBe("official");
    expect(body.node.sync).toBe(false);
    expect(body.notice).toBe("test node");
  });

  it("ignores an invalid NODE_ID (falls back to random)", async () => {
    freshEnv({ NODE_ID: "not-hex" });
    const body = await jsonOf<HealthBody>(healthResponse());
    expect(body.node.id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.node.id).not.toBe("not-hex");
  });

  it("is CORS-open and no-store", () => {
    const response = healthResponse();
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("route wiring: api/health.ts default export serves the manifest", async () => {
    const route = await import("../api/health");
    const response = await route.default(get("/api/health"));
    expect(response.status).toBe(200);
    expect((await jsonOf<HealthBody>(response)).ok).toBe(true);
  });
});