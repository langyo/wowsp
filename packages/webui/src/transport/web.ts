/**
 * Browser/mock transport: shims the Tauri command surface onto the mock FastAPI
 * backend under `/api`. Lets the webui run in `just dev --mock` and the Playwright
 * e2e harness without the Tauri shell.
 *
 * The mock backend exposes `GET /api/<cmd>` and `POST /api/<cmd>` mirroring the
 * Tauri command names (see scripts/mock/src/main.py). Args are sent as JSON
 * body for POST and query params for GET.
 */
import type { Transport } from "./types";
import { RpcError } from "./types";
import { RPC } from "@/rpc";

const GET_COMMANDS = new Set<string>([RPC.detect_game_install, RPC.list_replays]);

export class WebTransport implements Transport {
  async invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
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
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError((e as Error).message ?? String(e), cmd);
    }
  }
}
