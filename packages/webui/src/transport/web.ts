/**
 * Browser/mock transport: shims the Tauri command surface onto the mock FastAPI
 * backend under `/api`. Lets the webui run in `just dev --mock` and the Playwright
 * e2e harness without the Tauri shell.
 *
 * The mock backend exposes `GET /api/<cmd>` and `POST /api/<cmd>` mirroring the
 * Tauri command names (see scripts/mock/src/main.py). Args are sent as JSON
 * body for POST and query params for GET. Commands whose Rust handlers land
 * in a later phase (pairing, mobile replay import) are served by the
 * client-side `webMock` instead of the FastAPI backend; `list_replays_meta`
 * fetches normally and gains the mock session's imported/pulled entries.
 */
import type { Transport } from "./types";
import { RpcError } from "./types";
import { RPC } from "@/rpc";
import { MOCK_COMMANDS, mockImportedListing, mockListen } from "./webMock";

const GET_COMMANDS = new Set<string>([RPC.detect_game_install, RPC.list_replays]);

export class WebTransport implements Transport {
  async invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    // Client-side mock commands (no FastAPI counterpart until phase P).
    const mock = MOCK_COMMANDS[cmd];
    if (mock) {
      try {
        return (await mock(args ?? {})) as T;
      } catch (e) {
        throw e instanceof RpcError ? e : new RpcError((e as Error).message ?? String(e), cmd);
      }
    }
    const isGet = GET_COMMANDS.has(cmd) && !args;
    const url = `/api/${cmd}`;
    try {
      const res = isGet
        ? await fetch(url)
        : await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: args ? JSON.stringify(args) : "{}",
          });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new RpcError(`HTTP ${res.status}: ${text}`, cmd);
      }
      let payload = (await res.json()) as T;
      // Merge the mock session's imported/pulled files into the local list
      // so the mobile acquisition flows are visible in the replay rail.
      if (cmd === RPC.list_replays_meta && Array.isArray(payload)) {
        payload = [
          ...(mockImportedListing() as unknown[]),
          ...(payload as unknown[]),
        ] as T;
      }
      return payload;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError((e as Error).message ?? String(e), cmd);
    }
  }

  async listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
    // No backend push source in the browser — the in-process webMock emits
    // its pairing-progress ticks on this bus.
    return mockListen(event, handler as (payload: unknown) => void);
  }
}
