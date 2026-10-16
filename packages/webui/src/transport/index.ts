/**
 * Transport factory + lazy singleton.
 *
 * In the Tauri desktop shell, `invoke` reaches the Rust `#[tauri::command]`
 * handlers. In a plain browser (dev with the mock backend, or the e2e harness),
 * the same calls are shimmmed to `fetch` against the mock FastAPI app under
 * `/api`. The rest of the webui only ever sees `transport.invoke(cmd, args)`.
 */
import { TauriTransport } from "./tauri";
import { WebTransport } from "./web";
import type { Transport } from "./types";
import { isTauri } from "@/utils/platform";

/** Single source of truth lives in utils/platform (phone/desktop gating
 *  siblings live there); re-exported here for the many existing callers. */
export { isTauri };

export function createTransport(): Transport {
  return isTauri() ? new TauriTransport() : new WebTransport();
}

let _transport: Transport | null = null;

/** Lazily-instantiated global transport singleton. */
export const transport: Transport = new Proxy({} as Transport, {
  get(_target, prop, _receiver) {
    if (!_transport) {
      _transport = createTransport();
    }
    const value = Reflect.get(_transport, prop, _transport);
    return typeof value === "function" ? value.bind(_transport) : value;
  },
});

export type { Transport } from "./types";
