/**
 * Browser-mode mock for the mobile replay-acquisition + pairing commands.
 *
 * The Rust handlers for these commands land in phase P; until then the web
 * transport serves them from this in-process mock so the whole mobile flow
 * (file import, host pairing, PIN exchange, remote browsing, pulls with
 * progress) is developable and visually verifiable in `just dev mock`
 * TODAY. The mock lives client-side (not in scripts/mock) so the Tauri
 * builds route straight through to the real `#[tauri::command]` handlers
 * the moment phase P registers them.
 *
 * Mock facts (RFC 5737 documentation address — never a real host):
 * - pairing_start "serves" on 192.0.2.10:58041 with code 123456 (relay mode:
 *   the built-in gateway is "online" in the mock, so status reports
 *   mode "relay" / relayOnline true and the displayed code IS 123456);
 * - pairing_reallocate_code keeps the same mock code (the display refreshes);
 * - pairing_pair accepts ANY host:port but only code 123456, and mints the
 *   fixed token "mock-pairing-token";
 * - pairing_list_remote/pairing_pull_replay require that token;
 * - pulls simulate ~1.2 s of `wowsp://pairing-progress` ticks before the
 *   bytes "land" in the in-memory replay dir (also visible through
 *   list_replays_meta, which the web transport merges with this state);
 * - pairing_pull_gamedata simulates a ~2 s zip sync under the `:gamedata:`
 *   sentinel remoteName and reports a fixed file count;
 * - import_replay_file keeps the bytes only as a name in that same
 *   in-memory dir (the browser mock can't write the managed replays dir);
 * - pairing_discovery_start fakes one desktop beaconing onto the event bus
 *   ~0.9 s after the listener starts (LAN auto-discovery demo);
 * - pairing_get/set_relay_config keep the hidden gateway toggle in memory
 *   (enabled by default — the endpoint is built into the apps).
 */

/** ReplayMetaLite-shaped remote listing served by pairing_list_remote. */
const REMOTE_FIXTURE: Record<string, unknown>[] = [
  {
    path: "20260918_213010.wowsreplay",
    dateTime: "20260918_213010",
    matchGroup: "pvp",
    mapName: "17_NA_fault_line",
    mapId: 17,
    ownShipId: 4183305088,
    ownShipName: "Yamato",
    playerCount: 12,
  },
  {
    path: "20260917_195542.wowsreplay",
    dateTime: "20260917_195542",
    matchGroup: "ranked",
    mapName: "18_NE_ice_islands",
    mapId: 18,
    ownShipId: 4275189552,
    ownShipName: "Stalingrad",
    playerCount: 14,
  },
  {
    path: "20260915_221301.wowsreplay",
    dateTime: "20260915_221301",
    matchGroup: "pvp",
    mapName: "20_NE_two_brothers",
    mapId: 20,
    ownShipId: 4285609360,
    ownShipName: "Gearing",
    playerCount: 12,
  },
  {
    path: "20260912_184417.wowsreplay",
    dateTime: "20260912_184417",
    matchGroup: "pve",
    mapName: "14_Okinawa",
    mapId: 14,
    ownShipId: 4183305088,
    ownShipName: "Yamato",
    playerCount: 8,
  },
  {
    path: "20260910_201803.wowsreplay",
    dateTime: "20260910_201803",
    matchGroup: "pvp",
    mapName: "15_NE_north",
    mapId: 15,
    ownShipId: 4174884272,
    ownShipName: "Montana",
    playerCount: 12,
  },
];

/** The mock pairing "server" (desktop side). */
const MOCK_PIN = "123456";
const MOCK_TOKEN = "mock-pairing-token";
const MOCK_HOST = "192.0.2.10";
const MOCK_PORT = 58041;

let serverRunning = false;
/** Imported/pulled file names, merged into list_replays_meta responses. */
const importedFiles: { path: string; bytes: number }[] = [];
/** Active discovery "beacon" timer (fake desktop broadcasting on the bus). */
let discoveryTimer: number | null = null;
/** Persisted relay settings for the desktop-side settings mock (hidden
 *  toggle; enabled by default, endpoint built into the apps). */
let mockRelayConfig: { enabled: boolean } = { enabled: true };

/** The mock's running-status payload (relay mode: the gateway "answered").
 *  The v2 manifest fields echo their defaults (no upstream hop, no notice). */
function mockRunningStatus() {
  return {
    running: true,
    host: MOCK_HOST,
    port: MOCK_PORT,
    pin: MOCK_PIN,
    mode: "relay",
    relayOnline: true,
    provider: "wowsp",
    viaUpstream: false,
    notice: null,
  };
}

type MockHandler = (args: Record<string, unknown>) => Promise<unknown>;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rpcError(cmd: string, message: string): Error {
  const err = new Error(message);
  err.name = "RpcError";
  (err as Error & { cmd?: string }).cmd = cmd;
  return err;
}

/** In-process event bus the WebTransport's `listen` subscribes to (the
 *  browser has no Tauri push source; the mock emits pairing progress here). */
type MockListener = (payload: unknown) => void;
const listeners = new Map<number, { event: string; fn: MockListener }>();
let listenerSeq = 0;

export function mockListen(event: string, fn: MockListener): () => void {
  const id = ++listenerSeq;
  listeners.set(id, { event, fn });
  return () => listeners.delete(id);
}

function emitMockEvent(event: string, payload: unknown): void {
  for (const l of listeners.values()) if (l.event === event) l.fn(payload);
}

/** Derive a ReplayMetaLite entry for an imported/pulled mock file (the mock
 *  has no parser — recover what the filename carries, leave the rest null). */
function liteForName(path: string): Record<string, unknown> {
  const name = path.split(/[\\/]/).pop() ?? path;
  const m = name.match(/^(\d{8}(?:_\d{6})?)\.wowsreplay$/);
  return {
    path: `/mockdata/replays/${name}`,
    dateTime: m ? m[1] : null,
    matchGroup: null,
    mapName: null,
    mapId: null,
    ownShipId: null,
    ownShipName: null,
    playerCount: 0,
  };
}

/** Extra entries the web mock appends to a fetched list_replays_meta
 *  response (files imported/pulled during this session). */
export function mockImportedListing(): Record<string, unknown>[] {
  return importedFiles.map((f) => liteForName(f.path));
}

/** Command-name → mock handler. `list_replays_meta` is NOT here — the web
 *  transport fetches the real mock-backend response and appends
 *  `mockImportedListing()` on top (see WebTransport.invoke). */
export const MOCK_COMMANDS: Record<string, MockHandler> = {
  async import_replay_file(args) {
    const name = String(args.name ?? "");
    if (!name.toLowerCase().endsWith(".wowsreplay")) {
      throw rpcError("import_replay_file", "not a .wowsreplay file");
    }
    const bytes = Array.isArray(args.bytes) ? (args.bytes as number[]).length : 0;
    const path = `/mockdata/replays/${name}`;
    importedFiles.push({ path, bytes });
    return { path };
  },

  async pairing_start() {
    serverRunning = true;
    return mockRunningStatus();
  },

  async pairing_stop() {
    serverRunning = false;
    return null;
  },

  async pairing_get_status() {
    return serverRunning ? mockRunningStatus() : { running: false };
  },

  async pairing_reallocate_code() {
    if (!serverRunning) {
      throw rpcError("pairing_reallocate_code", "the pairing server is not running");
    }
    // Same code in the mock — the display just refreshes.
    return mockRunningStatus();
  },

  async pairing_pair(args) {
    if (String(args.pin ?? "") !== MOCK_PIN) {
      throw rpcError("pairing_pair", "invalid PIN");
    }
    // Internet mode echoes the (fake) room key the gateway "resolved" so
    // the wizard's store can persist it like the real backend does.
    const target = args.target as { kind?: string } | undefined;
    const room = target?.kind === "relay" ? `mock-room-${MOCK_PIN}` : undefined;
    return { token: MOCK_TOKEN, room };
  },

  async pairing_list_remote(args) {
    if (String(args.token ?? "") !== MOCK_TOKEN) {
      throw rpcError("pairing_list_remote", "invalid or expired token");
    }
    return REMOTE_FIXTURE;
  },

  async pairing_pull_replay(args) {
    if (String(args.token ?? "") !== MOCK_TOKEN) {
      throw rpcError("pairing_pull_replay", "invalid or expired token");
    }
    const remoteName = String(args.remoteName ?? "");
    const total = 8_000_000 + (remoteName.length % 7) * 1_100_000;
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      await delay(220);
      emitMockEvent("wowsp://pairing-progress", {
        remoteName,
        phase: "download",
        received: Math.round((total * i) / steps),
        total,
      });
    }
    const path = `/mockdata/replays/${remoteName.split(/[\\/]/).pop() ?? remoteName}`;
    importedFiles.push({ path, bytes: total });
    emitMockEvent("wowsp://pairing-progress", {
      remoteName,
      phase: "done",
      received: total,
      total,
    });
    return { path };
  },

  async pairing_pull_gamedata(args) {
    if (String(args.token ?? "") !== MOCK_TOKEN) {
      throw rpcError("pairing_pull_gamedata", "invalid or expired token");
    }
    // Same progress protocol as the Rust side: the `:gamedata:` sentinel
    // marks the zip sync on the shared stream (total is the file count in
    // the terminal event, mirroring GamedataSyncResult).
    const total = 260_000_000;
    const steps = 9;
    for (let i = 1; i <= steps; i++) {
      await delay(220);
      emitMockEvent("wowsp://pairing-progress", {
        remoteName: ":gamedata:",
        phase: "download",
        received: Math.round((total * i) / steps),
        total,
      });
    }
    const files = 4231;
    emitMockEvent("wowsp://pairing-progress", {
      remoteName: ":gamedata:",
      phase: "done",
      received: 0,
      total: files,
    });
    return { files };
  },

  // ── LAN discovery: a fake desktop appears shortly after the listener
  //    starts and keeps "beaconing" (so lastSeenAgeSec ticks) until stopped.
  //    No relay URL is advertised: the gateway endpoint is built into the
  //    apps (v2).
  async pairing_discovery_start() {
    if (discoveryTimer !== null) return null;
    const emit = () => {
      emitMockEvent("wowsp://pairing-discovery", {
        hosts: [
          {
            host: MOCK_HOST,
            port: MOCK_PORT,
            name: "DESKTOP-EXAMPLE",
            lastSeenAgeSec: 0,
          },
        ],
      });
    };
    discoveryTimer = window.setTimeout(() => {
      emit();
      discoveryTimer = window.setInterval(emit, 2000);
    }, 900);
    return null;
  },

  async pairing_discovery_stop() {
    if (discoveryTimer !== null) {
      window.clearTimeout(discoveryTimer);
      window.clearInterval(discoveryTimer);
      discoveryTimer = null;
    }
    return null;
  },

  // ── Internet gateway config (hidden desktop toggle).
  async pairing_get_relay_config() {
    return { ...mockRelayConfig };
  },

  async pairing_set_relay(args) {
    const config = args.config as { enabled?: boolean } | undefined;
    mockRelayConfig = { enabled: Boolean(config?.enabled) };
    return null;
  },
};
