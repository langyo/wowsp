/** Pairing domain of the WoWSP API client: the desktop pairing server,
 *  phone-side replay acquisition, LAN discovery and the internet gateway
 *  (composed into `api` by client.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";
import { isTauri } from "@/utils/platform";
import type { ReplayMetaLite } from "./replay";

/** State of the DESKTOP pairing server (`pairing_get_status` /
 *  `pairing_start`). While running, `host`/`port` is the LAN address the
 *  phone types in and `pin` the 6-digit code it must enter to obtain a
 *  token — the GATEWAY-ALLOCATED pairing code while the built-in internet
 *  gateway is online (`mode: "relay"`), the locally-generated LAN PIN
 *  otherwise (`mode: "lan-local"`). Mirrors
 *  `wowsp_tauri_shared::PairingStatus`. */
export interface PairingStatus {
  running: boolean;
  host?: string | null;
  port?: number | null;
  pin?: string | null;
  /** "relay" (gateway online) | "lan-local" (fallback), when running. */
  mode?: string | null;
  /** Whether the built-in internet gateway answered with a pairing code. */
  relayOnline?: boolean;
  /** Gateway manifest (protocol v2): the resolved gateway's provider, when
   *  a manifest was served (undefined in legacy v1 direct mode / offline). */
  provider?: string | null;
  /** Gateway manifest (protocol v2): true when the built-in address
   *  FORWARDED to an upstream exchange (someone else's infrastructure). */
  viaUpstream?: boolean;
  /** Gateway manifest (protocol v2): free-form operator notice (logged by
   *  the app; no UI renders it). */
  notice?: string | null;
}

/** Success result of `pairing_pair` — the bearer token every subsequent
 *  remote call (`pairing_list_remote` / `pairing_pull_replay`) sends back.
 *  Internet mode also returns the room key (the 64-hex random room id the
 *  gateway resolved the pairing code to) the session's tunnels are
 *  addressed by; LAN mode leaves it undefined. */
export interface PairingToken {
  token: string;
  room?: string | null;
}

/** Where a pairing call goes — direct LAN HTTP, or the same protocol bytes
 *  tunneled through the built-in pairing gateway. Mirrors
 *  `wowsp_tauri_shared::PairingTarget`. The gateway's `room` is the 64-hex
 *  random room id; it is omitted ONLY on the code exchange itself (the
 *  gateway resolves the 6-digit code to the room and hands the key back). */
export type PairingTarget =
  | { kind: "lan"; host: string; port: number }
  | { kind: "relay"; url: string; room?: string };

/** One desktop seen via the UDP discovery broadcast (`wowsp://pairing-discovery`
 *  snapshot entry). Mirrors `wowsp_tauri_shared::DiscoveredHost`. */
export interface DiscoveredHost {
  host: string;
  port: number;
  name: string;
  /** Seconds since the last broadcast arrived from this host. */
  lastSeenAgeSec: number;
  /** Worker URL the desktop advertises when its relay bridge is on. */
  relay?: string | null;
}

/** Snapshot pushed on `wowsp://pairing-discovery` whenever the live list
 *  changes. Mirrors `wowsp_tauri_shared::DiscoverySnapshot`. */
export interface DiscoverySnapshot {
  hosts: DiscoveredHost[];
}

/** Desktop's relay configuration (a HIDDEN setting — the endpoint is the
 *  built-in gateway, nothing user-configured). Mirrors
 *  `wowsp_tauri_shared::RelayConfig`. */
export interface RelayConfig {
  /** Whether the desktop bridges its pairing server through the built-in
   *  gateway while the server runs (default true). */
  enabled: boolean;
}

/** One replay on a paired desktop host — the SAME DTO as the local
 *  `list_replays_meta` card so the wizard reuses the replay-card markup.
 *  `path` is the remote file name; `pairing_pull_replay` takes it as
 *  `remoteName`. */
export type RemoteReplayEntry = ReplayMetaLite;

/** Progress push for one pairing pull (`wowsp://pairing-progress` — pairing
 *  keeps its OWN channel; it does not ride the unified download bus).
 *  `phase` is "download" | "done" |
 *  "error"; one event stream serves every concurrent pull, so filter by
 *  `remoteName`. Mirrors `wowsp_tauri_shared::PairingProgress` (phase P). */
export interface PairingProgress {
  remoteName: string;
  phase: string;
  received: number;
  /** Total bytes when known, else 0. */
  total: number;
  error?: string | null;
}

/** Result of `pairing_pull_gamedata` — how many game-data cache files
 *  (gameparams/** + encyclopedia/**) were merged into the local data dir.
 *  Mirrors `wowsp_tauri_shared::GamedataSyncResult`. */
export interface GamedataSyncResult {
  files: number;
}

/** Sentinel `remoteName` that marks the game-data zip sync on the shared
 *  `wowsp://pairing-progress` stream (mirrors the Rust constant). */
export const GAMEDATA_SENTINEL = ":gamedata:";

export const pairingApi = {
  // ── Mobile replay acquisition + desktop pairing (commands/pairing.rs) ────
  /** Write one .wowsreplay (picked via the HTML file input on mobile) into
   *  the managed replays dir. Under the Tauri shell the bytes travel as a
   *  RAW IPC body with the percent-encoded name in `x-replay-name` (same
   *  mechanism as saveExportBytes — a multi-MB replay as a JSON number
   *  array would balloon the IPC message); the browser mock keeps the JSON
   *  shape it understands. Backend sanitizes + dedupes; the frontend just
   *  displays the returned final path. */
  importReplayFile: (name: string, bytes: Uint8Array) =>
    isTauri()
      ? transport.invokeRaw?.<{ path: string }>(RPC.import_replay_file, bytes, {
          "x-replay-name": encodeURIComponent(name),
        }) ?? Promise.reject(new Error("raw IPC unavailable in this host"))
      : transport.invoke<{ path: string }>(RPC.import_replay_file, {
          name,
          bytes: Array.from(bytes),
        }),
  /** Start the desktop pairing server; resolves with the running status
   *  (LAN host:port + the 6-digit PIN to show). Desktop-only feature. */
  pairingStart: () => transport.invoke<PairingStatus>(RPC.pairing_start),
  pairingStop: () => transport.invoke<null>(RPC.pairing_stop),
  pairingGetStatus: () => transport.invoke<PairingStatus>(RPC.pairing_get_status),
  /** PIN exchange: prove to the desktop host that a human read its screen,
   *  obtain the bearer token for the remote calls. Over the relay the
   *  result also carries the room key derived from the PIN. */
  pairingPair: (target: PairingTarget, pin: string) =>
    transport.invoke<PairingToken>(RPC.pairing_pair, { target, pin }),
  /** List the paired desktop host's replays (same card DTO as the local
   *  list). Rejects on an invalid/expired token. */
  pairingListRemote: (target: PairingTarget, token: string) =>
    transport.invoke<RemoteReplayEntry[]>(RPC.pairing_list_remote, { target, token }),
  /** Pull one remote replay into the managed replays dir. Byte progress
   *  arrives through `wowsp://pairing-progress` events (filter by
   *  `remoteName`); the promise resolves with the local path once done. */
  pairingPullReplay: (target: PairingTarget, token: string, remoteName: string) =>
    transport.invoke<{ path: string }>(RPC.pairing_pull_replay, {
      target,
      token,
      remoteName,
    }),
  /** Pull the host's game-data caches (gameparams + encyclopedia zip) and
   *  merge/overwrite them into the local data dir. Progress rides the same
   *  `wowsp://pairing-progress` stream under the `:gamedata:` sentinel;
   *  resolves with the extracted file count. */
  pairingPullGamedata: (target: PairingTarget, token: string) =>
    transport.invoke<GamedataSyncResult>(RPC.pairing_pull_gamedata, { target, token }),
  /** Pairing pull progress stream (`wowsp://pairing-progress`). */
  listenPairingProgress: (handler: (p: PairingProgress) => void) =>
    transport.listen?.<PairingProgress>("wowsp://pairing-progress", handler),
  // ── LAN auto-discovery (commands/pairing_discovery.rs) ──────────────────
  /** Start the discovery listener (binds UDP 58042). MUST be stopped when
   *  the wizard closes. Snapshots arrive via `listenPairingDiscovery`. */
  pairingDiscoveryStart: () => transport.invoke<null>(RPC.pairing_discovery_start),
  pairingDiscoveryStop: () => transport.invoke<null>(RPC.pairing_discovery_stop),
  /** Live discovered-desktops stream (emitted on list changes, throttled
   *  to ~1 Hz by the backend). */
  listenPairingDiscovery: (handler: (s: DiscoverySnapshot) => void) =>
    transport.listen?.<DiscoverySnapshot>("wowsp://pairing-discovery", handler),
  // ── Internet gateway config (commands/pairing_relay/) ──────────────────
  pairingGetRelayConfig: () => transport.invoke<RelayConfig>(RPC.pairing_get_relay_config),
  pairingSetRelay: (config: RelayConfig) =>
    transport.invoke<null>(RPC.pairing_set_relay, { config }),
  /** Regenerate the gateway-allocated pairing code (desktop). Resolves with
   *  the fresh status whose `pin` carries the new code. */
  pairingReallocateCode: () => transport.invoke<PairingStatus>(RPC.pairing_reallocate_code),
};
