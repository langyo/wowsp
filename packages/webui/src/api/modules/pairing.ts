/** Pairing domain of the WoWSP API client — reduced to the phone's
 *  local replay import after the PIN pairing mode was retired
 *  (2026-11-13): the wizard, the LAN/relay pairing handshake, the
 *  desktop pairing server and the relay code rooms are all gone. The
 *  phone acquires replays by picking files (HTML file input →
 *  `import_replay_file`); live stats pair through the account-routed
 *  gateway (see modules/gateway.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";
import { isNative } from "@/utils/platform";

export const pairingApi = {
  /** Write one .wowsreplay (picked via the HTML file input on mobile) into
   *  the managed replays dir. Under the Tauri shell the bytes travel as a
   *  RAW IPC body with the percent-encoded name in `x-replay-name` (same
   *  mechanism as saveExportBytes — a multi-MB replay as a JSON number
   *  array would balloon the IPC message); the browser mock keeps the JSON
   *  shape it understands. Backend sanitizes + dedupes; the frontend just
   *  displays the returned final path. */
  importReplayFile: (name: string, bytes: Uint8Array) =>
    isNative()
      ? transport.invokeRaw?.<{ path: string }>(RPC.import_replay_file, bytes, {
          "x-replay-name": encodeURIComponent(name),
        }) ?? Promise.reject(new Error("raw IPC unavailable in this host"))
      : transport.invoke<{ path: string }>(RPC.import_replay_file, {
          name,
          bytes: Array.from(bytes),
        }),
};
