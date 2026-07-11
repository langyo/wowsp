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
