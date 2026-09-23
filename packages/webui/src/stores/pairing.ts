/**
 * Mobile↔desktop pairing state.
 *
 * Four concerns, one store:
 * - PAIRED HOSTS (mobile side): desktop WoWSP instances this phone has
 *   paired with, persisted through the existing `appdata_read`/`appdata_write`
 *   commands to `pairing-hosts.json` — same pattern as game-config.json,
 *   works on both the tauri shell and the browser mock with zero new Rust.
 *   Each entry records HOW it pairs: `mode: "lan"` (direct HTTP to a
 *   discovered/typed host:port) or `mode: "relay"` (the same protocol
 *   tunneled through the BUILT-IN pairing gateway; carries the room key the
 *   gateway resolved the pairing code to).
 * - LAN DISCOVERY (mobile side): the live "discovered computers" list fed by
 *   `wowsp://pairing-discovery` (commands/pairing_discovery.rs); the wizard
 *   starts the listener on open and MUST stop it on close.
 * - THE BUILT-IN GATEWAY (v2): internet pairing is PIN-ONLY — the endpoint
 *   (`gateway.wowsp.langyo.xyz`) is a hidden built-in service hardcoded in
 *   both apps, never user-configured.
 * - PAIRING SERVER (desktop side): the settings → pairing section's view of
 *   `pairing_start`/`pairing_stop`/`pairing_get_status`, the hidden gateway
 *   toggle, code regeneration, and the pull progress stream
 *   (`wowsp://pairing-progress`, same wiring as res-progress).
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import {
  api,
  GAMEDATA_SENTINEL,
  type DiscoveredHost,
  type DiscoverySnapshot,
  type PairingProgress,
  type PairingStatus,
  type PairingTarget,
  type RelayConfig,
} from "@/api";

const PAIRING_HOSTS_FILE = "pairing-hosts.json";

/**
 * The built-in internet-pairing gateway — ONE constant, same host as
 * `BUILTIN_RELAY_ROOT_URL` in commands/pairing_relay.rs (kept here in its
 * wss spelling; the Rust side normalizes either form onto the https root it
 * resolves the v2 gateway manifest from). The owner binds the DNS for this
 * host at deploy time; there is no user-facing configuration anywhere.
 */
export const PAIRING_GATEWAY_WS = "wss://gateway.wowsp.langyo.xyz";

/** How a paired entry reaches its desktop. */
export type PairingMode = "lan" | "relay";

/** One paired desktop host (persisted). */
export interface PairedHost {
  host: string;
  port: number;
  /** Bearer token from the PIN exchange — sent with every remote call. */
  token: string;
  /** Display name (defaults to host:port, editable later). */
  label: string;
  /** Unix ms of the last successful remote call (listing/pull). */
  lastSeen: number;
  /** Transport this entry pairs through (default "lan"). */
  mode: PairingMode;
  /** Internet mode: gateway base (kept for entry identity; defaults to the
   *  built-in constant). */
  relayUrl?: string;
  /** Internet mode: room key (64-hex random id the gateway resolved the
   *  pairing code to at pair time). */
  room?: string;
}

/** Shape of `pairing-hosts.json`. */
interface PairingFile {
  hosts: PairedHost[];
}

/** Parse + validate the manual add-host form. Returns null when either field
 *  is unusable (empty host, non-integer or out-of-range port). */
export function parseHostInput(
  host: string,
  portRaw: string | number,
): { host: string; port: number } | null {
  const host_ = String(host ?? "").trim();
  if (!host_) return null;
  const portNum = typeof portRaw === "number" ? portRaw : Number(String(portRaw ?? "").trim());
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
  return { host: host_, port: portNum };
}

/** Stable identity of a host entry (dedupe/upsert key). */
export function hostKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/** Stable identity for a paired entry (mode-aware: relay entries key on the
 *  relay URL since host/port carry no LAN meaning there). */
export function entryKey(entry: PairedHost): string {
  return entry.mode === "relay"
    ? `relay:${(entry.relayUrl ?? "").trim().toLowerCase()}`
    : hostKey(entry.host, entry.port);
}

/** Tolerant JSON parse of the persisted file (corrupt → empty defaults).
 *  Legacy files may carry a `relayUrl` key from the pre-v2 phone-side
 *  relay-URL feature — ignored now (the endpoint is built into the apps). */
export function parsePairingFile(raw: string | null | undefined): PairingFile {
  const fallback: PairingFile = { hosts: [] };
  if (!raw) return fallback;
  try {
    const data = JSON.parse(raw) as Partial<PairingFile>;
    const hosts = Array.isArray(data.hosts)
      ? data.hosts.filter(
          (h): h is PairedHost =>
            !!h &&
            typeof (h as PairedHost).host === "string" &&
            typeof (h as PairedHost).port === "number" &&
            typeof (h as PairedHost).token === "string",
        )
      : [];
    return { hosts };
  } catch {
    return fallback;
  }

}

/** Back-compat shim over [`parsePairingFile`] (list-only callers/tests). */
export function parseHostsFile(raw: string | null | undefined): PairedHost[] {
  return parsePairingFile(raw).hosts;
}

/** PairingTarget for a session's remote calls. Internet sessions address
 *  the built-in gateway (an entry's stored URL is only an identity fallback)
 *  and MUST carry their room key; a malformed entry surfaces as a clean
 *  error. */
export function sessionTargetOf(entry: PairedHost): PairingTarget {
  if (entry.mode === "relay") {
    return {
      kind: "relay",
      url: entry.relayUrl?.trim() || PAIRING_GATEWAY_WS,
      room: entry.room ?? undefined,
    };
  }
  return { kind: "lan", host: entry.host, port: entry.port };
}

/** Fresh internet-pairing target for the code exchange (no room yet — the
 *  gateway resolves the code and hands the key back). */
export function gatewayTarget(): PairingTarget {
  return { kind: "relay", url: PAIRING_GATEWAY_WS };
}

export const usePairingStore = defineStore("pairing", () => {
  // ── paired hosts (mobile side, persisted) ─────────────────────────────
  const hosts = ref<PairedHost[]>([]);
  const loaded = ref(false);

  async function load() {
    try {
      const file = parsePairingFile(await api.appdataRead(PAIRING_HOSTS_FILE));
      hosts.value = file.hosts;
    } catch {
      hosts.value = [];
    } finally {
      loaded.value = true;
    }
  }

  async function persist() {
    try {
      const file: PairingFile = { hosts: hosts.value };
      await api.appdataWrite(PAIRING_HOSTS_FILE, JSON.stringify(file));
    } catch {
      // best-effort — don't fail the action if persistence is unavailable
    }
  }

  /** PIN exchange → upsert the host entry with the minted token. Throws the
   *  transport's error on a wrong code / unreachable host (caller toasts). */
  async function pairAndSave(
    target: PairingTarget,
    pin: string,
    label?: string,
  ): Promise<PairedHost> {
    const { token, room } = await api.pairingPair(target, pin);
    const entry: PairedHost =
      target.kind === "lan"
        ? {
            host: target.host.trim(),
            port: target.port,
            token,
            label: label?.trim() || `${target.host.trim()}:${target.port}`,
            lastSeen: Date.now(),
            mode: "lan",
          }
        : {
            host: "",
            port: 0,
            token,
            label: label?.trim() || (target as { url: string }).url,
            lastSeen: Date.now(),
            mode: "relay",
            relayUrl: (target as { url: string }).url,
            room: room ?? undefined,
          };
    const key = entryKey(entry);
    const idx = hosts.value.findIndex((h) => entryKey(h) === key);
    if (idx >= 0) hosts.value.splice(idx, 1, entry);
    else hosts.value.push(entry);
    await persist();
    return entry;
  }

  function removeHost(host: string, port: number) {
    const key = hostKey(host, port);
    hosts.value = hosts.value.filter((h) => entryKey(h) !== key && hostKey(h.host, h.port) !== key);
    void persist();
  }

  /** Forget one entry by identity (mode-aware — internet entries all share
   *  the empty host:port, so removeHost cannot express them). */
  function removeEntry(entry: PairedHost) {
    const key = entryKey(entry);
    hosts.value = hosts.value.filter((h) => entryKey(h) !== key);
    void persist();
  }

  /** Stamp lastSeen after a successful listing/pull (no-op on an unknown host). */
  async function touchSeen(entry: PairedHost) {
    const key = entryKey(entry);
    const hit = hosts.value.find((h) => entryKey(h) === key);
    if (!hit) return;
    hit.lastSeen = Date.now();
    await persist();
  }

  /** List the host's replays; refreshes lastSeen on success. */
  async function listRemote(entry: PairedHost) {
    const list = await api.pairingListRemote(sessionTargetOf(entry), entry.token);
    await touchSeen(entry);
    return list;
  }

  // ── LAN discovery (mobile side, live) ───────────────────────────────────
  /** Latest discovered desktops (replaces wholesale on every snapshot). */
  const discovered = ref<DiscoveredHost[]>([]);
  const discoveryActive = ref(false);
  let discoveryWired = false;
  let discoveryUnlisten: (() => void) | null = null;

  function wireDiscovery() {
    if (discoveryWired) return;
    discoveryWired = true;
    const un = api.listenPairingDiscovery?.((s: DiscoverySnapshot) => {
      discovered.value = s.hosts;
    });
    if (un instanceof Promise) {
      void un.then((u) => {
        discoveryUnlisten = u;
      }).catch(() => {});
    } else if (un) {
      discoveryUnlisten = un;
    }
  }

  async function startDiscovery() {
    wireDiscovery();
    if (discoveryActive.value) return;
    discoveryActive.value = true;
    try {
      await api.pairingDiscoveryStart();
    } catch {
      // Port taken / platform refusal — the list just stays empty and the
      // wizard shows its manual entry fallback.
      discoveryActive.value = false;
    }
  }

  async function stopDiscovery() {
    if (!discoveryActive.value && !discoveryUnlisten) return;
    discoveryActive.value = false;
    try {
      await api.pairingDiscoveryStop();
    } catch {
      // already gone — nothing to do
    }
  }

  // ── pull progress (event stream) ─────────────────────────────────────
  /** Latest progress per remote file name — one stream serves all pulls. */
  const progressByFile = ref<Record<string, PairingProgress | undefined>>({});
  /** Latest game-data sync progress (the `:gamedata:` sentinel rides the
   *  same `wowsp://pairing-progress` stream — kept separate from the
   *  per-replay map so file cards never key on the sentinel). */
  const gamedataProgress = ref<PairingProgress | null>(null);
  let progressWired = false;

  function wireProgressStream() {
    if (progressWired) return;
    progressWired = true;
    // Outside the Tauri shell the web mock's bus feeds this; the optional
    // listener simply stays unset where neither exists. The store lives for
    // the app's lifetime, so the returned unlisten is intentionally dropped.
    const un = api.listenPairingProgress?.((p) => {
      if (p.remoteName === GAMEDATA_SENTINEL) gamedataProgress.value = p;
      else progressByFile.value[p.remoteName] = p;
    });
    if (un instanceof Promise) void un.catch(() => {});
  }

  /** Pull one remote replay; progress lands in `progressByFile`. The
   *  terminal "done"/"error" event stays so the card can show the outcome. */
  async function pullReplay(entry: PairedHost, remoteName: string) {
    wireProgressStream();
    progressByFile.value[remoteName] = {
      remoteName,
      phase: "download",
      received: 0,
      total: 0,
    };
    try {
      const out = await api.pairingPullReplay(sessionTargetOf(entry), entry.token, remoteName);
      await touchSeen(entry);
      return out;
    } catch (e) {
      progressByFile.value[remoteName] = {
        remoteName,
        phase: "error",
        received: 0,
        total: 0,
        error: e instanceof Error ? e.message : String(e),
      };
      throw e;
    }
  }

  /** Pull the host's game-data caches (gameparams + encyclopedia zip) and
   *  merge them into the local data dir. Progress lands in
   *  `gamedataProgress`; the terminal "done"/"error" event stays for the
   *  wizard's outcome display. */
  async function syncGamedata(entry: PairedHost) {
    wireProgressStream();
    gamedataProgress.value = {
      remoteName: GAMEDATA_SENTINEL,
      phase: "download",
      received: 0,
      total: 0,
    };
    try {
      const out = await api.pairingPullGamedata(sessionTargetOf(entry), entry.token);
      await touchSeen(entry);
      return out;
    } catch (e) {
      gamedataProgress.value = {
        remoteName: GAMEDATA_SENTINEL,
        phase: "error",
        received: 0,
        total: 0,
        error: e instanceof Error ? e.message : String(e),
      };
      throw e;
    }
  }

  // ── mobile file import (HTML file picker → managed replays dir) ──────
  /** Import picked files; returns per-file outcomes for the caller to toast. */
  async function importFiles(files: { name: string; bytes: Uint8Array }[]) {
    const imported: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const f of files) {
      try {
        const { path } = await api.importReplayFile(f.name, f.bytes);
        imported.push(path);
      } catch (e) {
        failed.push({ name: f.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { imported, failed };
  }

  // ── pairing server (desktop side, settings section) ──────────────────
  const server = ref<PairingStatus | null>(null);
  const serverBusy = ref(false);
  const serverError = ref<string | null>(null);

  async function refreshServerStatus() {
    try {
      server.value = await api.pairingGetStatus();
    } catch {
      server.value = null;
    }
  }

  async function startServer() {
    serverBusy.value = true;
    serverError.value = null;
    try {
      server.value = await api.pairingStart();
    } catch (e) {
      serverError.value = e instanceof Error ? e.message : String(e);
    } finally {
      serverBusy.value = false;
    }
  }

  async function stopServer() {
    serverBusy.value = true;
    serverError.value = null;
    try {
      await api.pairingStop();
      server.value = await api.pairingGetStatus();
    } catch (e) {
      serverError.value = e instanceof Error ? e.message : String(e);
    } finally {
      serverBusy.value = false;
    }
  }

  // ── gateway config (desktop side, hidden toggle) + code regeneration ──
  const relayConfig = ref<RelayConfig>({ enabled: true });
  const relayBusy = ref(false);
  const relayError = ref<string | null>(null);
  const relaySavedTick = ref(0);

  async function loadRelayConfig() {
    try {
      relayConfig.value = await api.pairingGetRelayConfig();
    } catch {
      // keep defaults
    }
  }

  async function saveRelayConfig(next: RelayConfig) {
    relayBusy.value = true;
    relayError.value = null;
    try {
      await api.pairingSetRelay(next);
      relayConfig.value = { ...next };
      relaySavedTick.value += 1;
    } catch (e) {
      relayError.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      relayBusy.value = false;
    }
  }

  /** Ask the gateway for a FRESH pairing code (the desktop's regenerate
   *  button); the server status (whose `pin` carries the new code) is
   *  refreshed in place. Throws when no server/bridge is running. */
  async function reallocateCode() {
    serverError.value = null;
    try {
      server.value = await api.pairingReallocateCode();
    } catch (e) {
      serverError.value = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  return {
    hosts,
    loaded,
    load,
    pairAndSave,
    removeHost,
    removeEntry,
    touchSeen,
    listRemote,
    // discovery
    discovered,
    discoveryActive,
    startDiscovery,
    stopDiscovery,
    // progress
    progressByFile,
    gamedataProgress,
    wireProgressStream,
    pullReplay,
    syncGamedata,
    importFiles,
    // desktop server
    server,
    serverBusy,
    serverError,
    refreshServerStatus,
    startServer,
    stopServer,
    reallocateCode,
    // gateway config (desktop, hidden)
    relayConfig,
    relayBusy,
    relayError,
    relaySavedTick,
    loadRelayConfig,
    saveRelayConfig,
  };
});
