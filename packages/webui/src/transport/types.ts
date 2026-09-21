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

/** Which failure an interactive lookup rejection is (mirrors the Rust
 *  `LookupErrorKind` in commands/lookup_error.rs). */
export type LookupErrorKind = "account_not_found" | "clan_not_found" | "api";

/** Structured payload the interactive lookup commands
 *  (`lookup_player_stats` / `lookup_clan_info`) attach to their IPC
 *  rejection, so the UI can localize "not found" per kind and surface the
 *  official API's error message instead of parsing English sentences. */
export interface LookupErrorPayload {
  kind: LookupErrorKind;
  /** Query that found nothing (nickname / UID / clan id); "" for api. */
  query: string;
  /** Realm the failed search ran on; "" for api. */
  realm: string;
  /** Historical English fallback text (also the log-friendly rendering). */
  message: string;
  /** Official API error message (e.g. REQUEST_LIMIT_EXCEEDED) when the
   *  response carried one, else null. */
  detail: string | null;
}

/** RpcError carrying a structured lookup payload. */
export class LookupError extends RpcError {
  constructor(
    readonly payload: LookupErrorPayload,
    message: string,
    cmd: string,
  ) {
    super(message, cmd);
    this.name = "LookupError";
  }

  /** Wrap an IPC rejection when it looks like a serialized Rust
   *  `LookupError` (an object whose `kind` is one of the known kinds);
   *  null for every other rejection shape, so callers can fall back to the
   *  plain-string path. Unknown kinds — a future Rust-side addition, or
   *  another command that happens to reject with a `kind` object — must
   *  keep taking the plain-string path, never a wrong UI branch. */
  static from(rejection: unknown, cmd: string): LookupError | null {
    if (typeof rejection !== "object" || rejection === null) return null;
    const r = rejection as Record<string, unknown>;
    const kind = r.kind;
    if (
      kind !== "account_not_found" &&
      kind !== "clan_not_found" &&
      kind !== "api"
    ) {
      return null;
    }
    const message = typeof r.message === "string" ? r.message : "";
    return new LookupError(
      {
        kind,
        query: typeof r.query === "string" ? r.query : "",
        realm: typeof r.realm === "string" ? r.realm : "",
        message,
        detail: typeof r.detail === "string" ? r.detail : null,
      },
      // `message` doubles as this error's `.message`, keeping the existing
      // `(e as Error).message` consumers on the historical English string.
      message || kind,
      cmd,
    );
  }
}
