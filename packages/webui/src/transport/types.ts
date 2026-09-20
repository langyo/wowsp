/**
 * Transport interface contract. Both `TauriTransport` (desktop) and
 * `WebTransport` (browser/mock) implement this so feature code is identical
 * regardless of host.
 *
 * Adapted from shittim-chest's transport layer, trimmed to WoWSP's needs
 * (invoke + optional event listen for the arena-info push).
 */
export interface Transport {
  /**
   * Invoke a WoWSP command by name with optional args. Returns the command's
   * `Result<T, String>` payload (unwrapped — rejections throw).
   */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;

  /**
   * Subscribe to a Tauri backend event. Returns an unsubscribe function.
   * Returns a no-op unsubscribe when running outside the Tauri shell (mock
   * mode has no push source).
   */
  listen?<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void>;

  /**
   * Invoke a command with a RAW binary body (Uint8Array) plus header metadata.
   * Used for large exports (tactical-board PNG/WebP/MP4) where a JSON body
   * would balloon the IPC message. The Rust side reads the bytes via
   * `tauri::ipc::Request` (`InvokeBody::Raw`) and the header via
   * `request.headers()`. Rejects outside the Tauri shell — callers are
   * expected to offer a browser-download fallback when this rejects.
   */
  invokeRaw?<T = unknown>(
    cmd: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): Promise<T>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly cmd: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
