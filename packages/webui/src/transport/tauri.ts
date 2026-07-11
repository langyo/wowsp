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
      // Tauri rejection: the Rust side returned `Err(String)`, surfaced as a
      // string (or object with a `message`). Normalize to RpcError.
      const msg = typeof e === "string" ? e : (e as { message?: string })?.message ?? String(e);
      throw new RpcError(msg, cmd);
    }
  }
}
