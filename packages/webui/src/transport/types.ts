/**
 * Transport interface contract. Both `TauriTransport` (desktop) and
 * `WebTransport` (browser/mock) implement this so feature code is identical
 * regardless of host.
 *
 * Adapted from shittim-chest's transport layer, trimmed to WoWSP's needs
 * (no RPC streaming, no auth, no device channels — just command invoke).
 */
export interface Transport {
  /**
   * Invoke a WoWSP command by name with optional args. Returns the command's
   * `Result<T, String>` payload (unwrapped — rejections throw).
   */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
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
