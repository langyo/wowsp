/**
 * Desktop transport: delegates every `invoke` to the Tauri core invoke bridge,
 * which reaches the Rust `#[tauri::command]` handlers in
 * `packages/app/tauri/src/commands/`.
 */
import type { Transport } from "./types";
import { RpcError } from "./types";

interface TauriGlobal {
  core?: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  event?: {
    listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
}

export class TauriTransport implements Transport {
  private get invokeFn() {
    const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    if (!t?.core?.invoke) {
      throw new RpcError("Tauri core.invoke unavailable", "transport");
    }
    return t.core.invoke;
  }

  async invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await this.invokeFn(cmd, args)) as T;
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as { message?: string })?.message ?? String(e);
      throw new RpcError(msg, cmd);
    }
  }

  async listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
    const listenFn = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.event?.listen;
    if (!listenFn) {
      // Not in Tauri shell (mock/browser) — no backend push source.
      return () => {};
    }
    return listenFn(event, (e) => handler(e.payload as T));
  }
}
