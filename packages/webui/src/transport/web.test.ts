/** The browser transport's fast-fail for a backend-less dev session:
 *  `just dev webui` has nothing behind the /api proxy, so RPCs must fail
 *  with one message instead of fetching (Vite logged an ECONNREFUSED stack
 *  per call on startup — 2026-11-07 report). */
import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcError } from "./types";
import { WebTransport, noBackendDevSession } from "./web";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web transport dev-session gate", () => {
  it("fails fast without fetching when the session has no backend", async () => {
    vi.stubGlobal("__WOWSP_NO_BACKEND__", true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(noBackendDevSession()).toBe(true);
    const transport = new WebTransport();
    await expect(transport.invoke("is_portable")).rejects.toBeInstanceOf(
      RpcError,
    );
    await expect(transport.invoke("is_portable")).rejects.toThrow(
      /just dev mock/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches the mock backend normally when the flag is absent", async () => {
    expect(noBackendDevSession()).toBe(false);
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => 7,
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new WebTransport();
    await expect(transport.invoke("is_portable")).resolves.toBe(7);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
