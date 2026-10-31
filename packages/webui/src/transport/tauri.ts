/**
 * Desktop transport: delegates every `invoke` to the Tauri core invoke bridge,
 * which reaches the Rust `#[tauri::command]` handlers in
 * `packages/app/tauri/src/commands/`.
 */
import type { HostWindow } from "@/utils/typing";

import type { Transport } from "./types";
import { LookupError, RpcError } from "./types";

interface TauriGlobal {
  core?: {
    invoke: (
      cmd: string,
      args?: Record<string, unknown> | Uint8Array,
      options?: { headers?: Record<string, string> },
    ) => Promise<unknown>;
  };
  event?: {
    listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
}

export class TauriTransport implements Transport {
  private get invokeFn() {
    const t = (window as HostWindow<{ __TAURI__?: TauriGlobal }>).__TAURI__;
    if (!t?.core?.invoke) {
      throw new RpcError("Tauri core.invoke unavailable", "transport");
    }
    return t.core.invoke;
  }

  async invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await this.invokeFn(cmd, args)) as T;
    } catch (e) {
      // The interactive lookup commands reject with a structured payload —
      // wrap it so stores can branch on kind. Everything else keeps the
      // plain-string → RpcError path.
      const lookup = LookupError.from(e, cmd);
      if (lookup) throw lookup;
      const msg = typeof e === "string" ? e : (e as { message?: string })?.message ?? String(e);
      throw new RpcError(msg, cmd);
    }
  }

  async invokeRaw<T = unknown>(
    cmd: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): Promise<T> {
    // A Uint8Array args payload travels as the request's raw body (Tauri v2
    // custom-protocol IPC), never JSON-encoded — see write_export_bytes.
    return (await this.invokeFn(cmd, body, { headers })) as T;
  }

  async invokeBin(cmd: string, args?: Record<string, unknown>): Promise<ArrayBuffer> {
    // A command answering `tauri::ipc::Response` with bytes makes the IPC
    // custom protocol resolve the fetch body as an ArrayBuffer (tauri's
    // scripts/ipc-protocol.js takes the arrayBuffer branch for any non-JSON
    // content-type). JSON errors still reject through the same invoke
    // wrapper, so the RpcError mapping in `invoke` keeps applying.
    const out = await this.invoke<unknown>(cmd, args);
    if (out instanceof ArrayBuffer) return out;
    // postMessage fallback: Tauri may deliver the bytes as a plain number
    // array — repack it instead of failing the call.
    if (Array.isArray(out)) {
      const u8 = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) u8[i] = out[i] as number;
      return u8.buffer;
    }
    throw new RpcError("binary IPC unavailable (unexpected payload shape)", cmd);
  }

  async listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
    const listenFn = (window as HostWindow<{ __TAURI__?: TauriGlobal }>).__TAURI__?.event?.listen;
    if (!listenFn) {
      // Not in Tauri shell (mock/browser) — no backend push source.
      return () => {};
    }
    return listenFn(event, (e) => handler(e.payload as T));
  }
}
