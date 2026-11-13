/**
 * Browser-mode mock for the mobile replay-import + gateway-push commands.
 *
 * The Rust handlers for these commands live in the app; the web transport
 * serves them from this in-process mock so the mobile flow is developable
 * and visually verifiable in `just dev mock`. The mock lives client-side
 * (not in scripts/mock) so the Tauri builds route straight through to the
 * real `#[tauri::command]` handlers.
 *
 * Mock facts:
 * - import_replay_file keeps the bytes only as a name in the in-memory
 *   replay dir (also visible through list_replays_meta, which the web
 *   transport merges with this state — the browser mock can't write the
 *   managed replays dir);
 * - the PIN-pairing family (server, code exchange, remote browsing and
 *   pulls, LAN discovery, relay config) was retired with the PIN pairing
 *   mode on 2026-11-13 and has no mock surface anymore.
 *
 * Gateway push (docs/en/designs/gateway-push.md §9; browser dev ?mobileApp=1):
 * - gateway_get/set_config keep the route entry in memory (official root
 *   default, service off);
 * - gateway_get_health answers a v1 doc: turnstile+password OFF for the
 *   official root, turnstile ON (with Cloudflare's always-passes TEST
 *   sitekey) for any custom root containing "captcha" so the sheet flow
 *   is devable;
 * - gateway_open_session mints a fixed ticket (rejecting with the contract
 *   markers when the doc demanded a credential and none came);
 * - publish/subscribe simulate wowsp://gateway-state (resolving→
 *   connecting→online) and a subscribe emits a mock battle frame + host
 *   presence ~0.8 s after going online (bye/host-offline on stop);
 * - the selfhost probe reports a plausible partial env; each step streams
 *   a few wowsp://gateway-selfhost lines then a done result (deploy/verify
 *   carry the RFC 2606 example URL https://gateway.example.com/gateway/).
 */


/** Imported/pulled file names, merged into list_replays_meta responses. */
const importedFiles: { path: string; bytes: number }[] = [];

/** Gateway-push mock state (route entry + socket liveness). */
const MOCK_GATEWAY_ROOT = "https://wowsp.langyo.xyz/gateway/";
let mockGatewayRoot = MOCK_GATEWAY_ROOT;
let mockGatewayEnabled = false;
/** The mock publisher's link state (the tray's status read + subs event). */
let mockPubRoute: string | null = null;
let mockPubSubs = 0;
/** Pending subscribe-simulation timers (battle frame + presence). */
let mockSubTimers: number[] = [];

/** Cloudflare Turnstile's documented always-passes TEST sitekey (public
 *  fixture from the Turnstile docs, not a secret). */
const MOCK_TURNSTILE_SITEKEY = "1x00000000000000000000AA";
/** The mock gateway's single-use ticket. */
const MOCK_GATEWAY_TICKET = "mock-gateway-ticket";

function mockGatewayHealth(root: string): Record<string, unknown> {
  const captchaNode = /captcha/i.test(root);
  return {
    gateway: "v1",
    minClientVersion: "0.6.8",
    auth: {
      turnstile: {
        required: captchaNode,
        sitekey: captchaNode ? MOCK_TURNSTILE_SITEKEY : null,
      },
      password: { required: false },
    },
    notice: null,
  };
}

function gatewayCaptchaRequired(root: string): boolean {
  const auth = mockGatewayHealth(root).auth as {
    turnstile: { required: boolean };
  };
  return auth.turnstile.required;
}

/** The mock's subscribe-side battle frame: a small real-ship roster whose
 *  dateTime is NOW (game-local "DD.MM.YYYY HH:MM:SS") so the live view's
 *  battle clock ticks from the moment the mock "connected". */
function mockBattleFrame(route: string): Record<string, unknown> {
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const dateTime =
    p2(now.getDate()) + "." + p2(now.getMonth() + 1) + "." + now.getFullYear() +
    " " + p2(now.getHours()) + ":" + p2(now.getMinutes()) + ":" + p2(now.getSeconds());
  return {
    type: "battle",
    realm: "asia",
    route,
    self: { name: "MockCaptain", accountId: 123456 },
    battle: {
      dateTime,
      matchGroup: "pvp",
      mapName: "17_NA_fault_line",
      scenario: "domination_3point",
      eventType: "",
      botCount: 0,
      scriptedUnitCount: 0,
      vehicles: [
        { id: 123456, name: "MockCaptain", relation: 0, shipId: 4276041424, shipName: "Yamato" },
        { id: 222001, name: "MockAlly", relation: 1, shipId: 4281219056, shipName: "Gearing" },
        { id: 222002, name: "MockAlly2", relation: 1, shipId: 4282267344, shipName: "Shimakaze" },
        { id: 333001, name: "MockEnemy", relation: 2, shipId: 3760109008, shipName: "Stalingrad" },
        { id: 333002, name: "MockEnemy2", relation: 2, shipId: 4276041424, shipName: "Yamato" },
      ],
    },
  };
}

function clearMockSubTimers(): void {
  for (const t of mockSubTimers) window.clearTimeout(t);
  mockSubTimers = [];
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
 * browser has no Tauri push source; the mock emits its gateway state
 * events here). */
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

/* The fixture `playerName`s are NICKNAMES (the recorder of each row) — two of
   them, matching the two pretend clients, so the playtime store's rows and the
   rail's player dimension carry the same kind of identity: one client can be
   played by several accounts in turn. */

/** playtime_battles fixture — a few rows across two obviously-fake installs
 *  (shipIds are real offline-DB ids so the view's breakdown labels resolve;
 *  the last row is an unparsed Lesta replay: descriptor fields null, only
 *  the filename's dateTime recovered). Sorted dateTime asc per contract.
 *  The paths ARE the two installs the FastAPI mock's detect_game_install
 *  reports (scripts/mock/src/main.py), so the playtime scope menu's
 *  per-client picks answer real rows in `just dev mock` — the menu lists
 *  detected installs, and a fixture root no install claims would make every
 *  client pick look empty. */
const MOCK_BATTLES = {
  battles: [
    {
      installPath: "D:\\Games\\World_of_Warships",
      kind: "steam",
      realm: "asia",
      dateTime: "20260910_201803",
      matchGroup: "pvp",
      scenario: "domination_3point",
      eventType: null,
      botCount: 0,
      scriptedUnitCount: 0,
      enemyCount: 12,
      ownShipId: 4276041424, // Yamato
      playerName: "MockCaptain",
      playerCount: 12,
    },
    {
      installPath: "C:\\MockGames\\WoWS (Lesta)",
      kind: "lesta",
      realm: "ru",
      dateTime: "20260911_190000",
      matchGroup: "pve",
      scenario: "pcvo009_op_02_02",
      eventType: "PCVO009_OP_02_02",
      botCount: 8,
      scriptedUnitCount: 8,
      enemyCount: 8,
      ownShipId: 4179605488, // Midway
      playerName: "MockCaptain",
      playerCount: 7,
    },
    {
      installPath: "D:\\Games\\World_of_Warships",
      kind: "steam",
      realm: "asia",
      dateTime: "20260912_184417",
      matchGroup: "pve",
      scenario: "domination_2point",
      eventType: null,
      botCount: 11,
      scriptedUnitCount: 0,
      // Plain co-op: the enemy bot side is listed, so the single-team
      // operation rule leaves this mock row on 联合作战. 4 works with
      // playerCount 9 — with scriptedUnitCount 0 every roster entry is a
      // listed player, so enemyCount can never exceed playerCount.
      enemyCount: 4,
      ownShipId: 4281219056, // Gearing
      playerName: "MockCaptain",
      playerCount: 9,
    },
    {
      installPath: "D:\\Games\\World_of_Warships",
      kind: "steam",
      realm: "asia",
      dateTime: "20260915_221301",
      matchGroup: "pvp",
      scenario: "domination_3point",
      eventType: null,
      botCount: 0,
      scriptedUnitCount: 0,
      enemyCount: 12,
      ownShipId: 3760109008, // Stalingrad
      playerName: "MockAlt",
      playerCount: 12,
    },
    {
      installPath: "D:\\Games\\World_of_Warships",
      kind: "steam",
      realm: "asia",
      dateTime: "20260918_213010",
      matchGroup: "ranked",
      scenario: null,
      eventType: null,
      botCount: 0,
      scriptedUnitCount: 0,
      enemyCount: 8,
      ownShipId: 4282267344, // Shimakaze
      playerName: "MockAlt",
      playerCount: 8,
    },
    {
      // Unparsed Lesta replay: the parser recovered nothing but the name.
      installPath: "C:\\MockGames\\WoWS (Lesta)",
      kind: "lesta",
      realm: "ru",
      dateTime: "20260919_175512",
      matchGroup: null,
      scenario: null,
      eventType: null,
      botCount: 0,
      scriptedUnitCount: 0,
      enemyCount: 0,
      ownShipId: null,
      playerName: null,
      playerCount: 0,
    },
  ],
};

/** Derive a ReplayMetaLite entry for an imported/pulled mock file (the mock
 *  has no parser — recover what the filename carries, leave the rest null).
 *  The install tags stay null: these files sit in the browser mock's managed
 *  dir, which belongs to no detected client — the unowned-root state the
 *  rail's client filter is supposed to EXCLUDE once a client is picked. */
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
    playerName: null,
    playerCount: 0,
    enemyCount: 0,
    installPath: null,
    installKind: null,
    installRealm: null,
  };
}

/** Extra entries the web mock appends to a fetched list_replays_meta
 *  response (files imported/pulled during this session). The merge itself
 *  is arg-agnostic on purpose (see MOCK_COMMANDS' note): the command's new
 *  `all` flag only changes the BACKEND scan in Rust, and the browser mock
 *  keeps merging its local session entries into either response shape. */
export function mockImportedListing(): Record<string, unknown>[] {
  return importedFiles.map((f) => liteForName(f.path));
}

// ── GitHub mirror ladder mock (browser dev; the Rust side always knows
//    the real ladder, so the mock answers the static contract set — the
//    official endpoint + the four built-ins, no user rows, since this
//    mock has no persisted network config). The probe answers
//    deterministically so every pill state is visible: one built-in row
//    "times out" on purpose.
const MOCK_MIRROR_LADDER = {
  official: "https://github.com",
  builtIn: [
    "https://ghp.ci",
    "https://gh-proxy.com",
    "https://ghfast.top",
    "https://ghproxy.net",
  ],
  user: [] as string[],
};

/** Fixed probe verdicts per prefix (ladder order is official → built-in →
 *  user, so the mock folds rows back in that same order). */
const MOCK_MIRROR_PROBE: Record<string, { ok: boolean; elapsedMs: number; error: string | null }> = {
  "https://github.com": { ok: true, elapsedMs: 180, error: null },
  "https://ghp.ci": { ok: true, elapsedMs: 250, error: null },
  "https://gh-proxy.com": { ok: true, elapsedMs: 300, error: null },
  "https://ghfast.top": { ok: true, elapsedMs: 220, error: null },
  "https://ghproxy.net": { ok: false, elapsedMs: 8000, error: "timeout" },
};

// ── AI model channel mock (browser dev; the Rust channel fetches and
//    authenticates the real signed Hugging Face manifest, while the mock
//    answers a deterministic local install + a newer published seq so the
//    settings card renders both the installed and the update-available
//    branches). The published set carries the current T4 three-head torpedo
//    slot; the installed (older) pack still carries only the legacy two-head
//    file, which is exactly the migration the card has to show.
const MOCK_AI_FILES = [
  {
    path: "fire_model.onnx",
    size: 2592543,
    sha256:
      "8ba95cc2e29a0f5e0a0d1f4a7b2f1c5c1f3a2d4b6c8e0f1a3b5c7d9e1f3a5b7c",
    kind: "fire-two-head",
    featureSet: "fire-v1",
  },
  {
    path: "move_model.onnx",
    size: 2652542,
    sha256:
      "bc91bdd3f1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8",
    kind: "move-sectors-17",
    featureSet: "move-v1",
  },
  {
    path: "advice_fire_model.onnx",
    size: 2595135,
    sha256:
      "b98f59ac1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
    kind: "advice-fire-attrs",
    featureSet: "advice-e24",
  },
  {
    // The current T4 three-head diagnostic slot (49-wide global block).
    // New releases no longer carry the legacy two-head file; old packs keep
    // it and the app falls back to it when this slot is absent.
    path: "torpedo4_model.onnx",
    size: 502518,
    sha256:
      "0b1f4efd7995991f3717d433179fe7eb12dba7b9de86f4bb0c2377e15a8ad908",
    kind: "torpedo-t4-three-head",
    featureSet: "torp4-v1",
  },
  {
    path: "ship_attributes.json",
    size: 261507,
    sha256:
      "2bbd3831aabbccddeeff00112233445566778899aabbccddeeff00112233445566",
  },
];

const MOCK_AI_STATUS = {
  installed: true,
  seq: 1,
  version: "2026-11-09T00:00:00Z",
  treeSha256:
    "95088f9c70486bb66300e80a0165d482e7b2098984d72e45db9fa0e64561fcdd",
  revision: "a1bae028c41641ecb1715aa3c318e8d320c322f2",
  installedAt: "2026-11-09T00:00:00Z",
  sizeBytes: 8388138,
  losMaps: 12,
  losSkipped: false,
  models: [
    { path: "fire_model.onnx", present: true, sizeBytes: 2592543 },
    { path: "move_model.onnx", present: true, sizeBytes: 2652542 },
    { path: "advice_fire_model.onnx", present: true, sizeBytes: 2595135 },
    // The installed mock pack predates the T4 slot: the current slot is
    // listed but absent, the legacy two-head file is what it carries.
    { path: "torpedo4_model.onnx", present: false, sizeBytes: 0 },
    { path: "torpedo_model.onnx", present: true, sizeBytes: 492411 },
    { path: "ship_attributes.json", present: true, sizeBytes: 261507 },
  ],
};

/** Command-name → mock handler. `list_replays_meta` is NOT here — the web
 *  transport fetches the real mock-backend response and appends
 *  `mockImportedListing()` on top (see WebTransport.invoke). */
export const MOCK_COMMANDS: Record<string, MockHandler> = {
  async ai_pack_status() {
    return MOCK_AI_STATUS;
  },

  async ai_pack_check() {
    const totalBytes = MOCK_AI_FILES.reduce((sum, f) => sum + f.size, 0);
    return {
      current: MOCK_AI_STATUS,
      // The newer published release carries the T4 slot (seq 3).
      latestSeq: 3,
      latestVersion: "2026-11-11T00:00:00Z",
      latestTreeSha256:
        "71d3a0c2f4e6b8d1a3c5e7f9b0d2f4a6c8e0b1d3f5a7c9e2b4d6f8a0c1e3b5d7",
      latestRevision: "b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2",
      totalBytes,
      losIncluded: true,
      losMismatch: false,
      files: MOCK_AI_FILES,
      endpoint: "https://hf-mirror.com",
      manifestSha256:
        "5e7f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
      checkedAt: new Date().toISOString(),
      updateAvailable: true,
    };
  },

  async ai_pack_download() {
    return null;
  },

  async ai_pack_cancel() {
    return null;
  },

  async import_replay_file(args) {
    const name = String(args.name ?? "");
    // The Lesta client renames its replays to .korablireplay.
    if (!/\.(wowsreplay|korablireplay)$/i.test(name)) {
      throw rpcError("import_replay_file", "not a replay container file");
    }
    const bytes = Array.isArray(args.bytes) ? (args.bytes as number[]).length : 0;
    const path = `/mockdata/replays/${name}`;
    importedFiles.push({ path, bytes });
    return { path };
  },

  // ── Gateway push (§9). Health/session simulate the exchange; the
  //    socket commands drive the mock state-event bus; the selfhost
  //    surface streams a short scripted pass.
  async gateway_get_config() {
    return { root: mockGatewayRoot, enabled: mockGatewayEnabled };
  },

  async gateway_set_config(args) {
    if (typeof args.root === "string" && args.root.trim() !== "") {
      // Same normalization class as the Rust URL policy: fold trailing
      // slashes onto ONE; reject non-https except loopback dev roots.
      const root = args.root.trim().replace(/\/+$/, "");
      if (!/^https:\//.test(root) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(root)) {
        throw rpcError("gateway_set_config", "gateway root must be an https URL");
      }
      mockGatewayRoot = root + "/";
    }
    if (typeof args.enabled === "boolean") mockGatewayEnabled = args.enabled;
    return { root: mockGatewayRoot, enabled: mockGatewayEnabled };
  },

  async gateway_get_health(args) {
    const root = String(args.root ?? "");
    if (/unreachable/.test(root)) {
      throw rpcError(
        "gateway_get_health",
        "gateway unreachable or health document invalid",
      );
    }
    await delay(150);
    return mockGatewayHealth(root);
  },

  async gateway_open_session(args) {
    const root = String(args.root ?? "");
    const password = typeof args.password === "string" ? args.password : "";
    if (gatewayCaptchaRequired(root) && !args.turnstileToken) {
      throw rpcError("gateway_open_session", "gateway captcha verification failed");
    }
    if (password === "wrong") {
      throw rpcError("gateway_open_session", "gateway password rejected");
    }
    if (password === "ratelimit") {
      throw rpcError("gateway_open_session", "gateway rate limited, retry after 42s");
    }
    return { ticket: MOCK_GATEWAY_TICKET, ttl: 120 };
  },

  async gateway_publish_start(args) {
    const route = String(args.route ?? "");
    if (!/^r:[a-z]{2,5}:[0-9]+$/.test(route)) {
      throw rpcError("gateway_publish_start", "invalid gateway route");
    }
    const emit = (phase: string, detail?: string) =>
      emitMockEvent("wowsp://gateway-state", { role: "pub", route, phase, detail: detail ?? null });
    emit("resolving");
    await delay(200);
    if (gatewayCaptchaRequired(mockGatewayRoot) && !args.turnstileToken) {
      emit("captcha");
      throw rpcError("gateway_publish_start", "gateway captcha verification failed");
    }
    emit("connecting");
    await delay(250);
    emit("online");
    mockPubRoute = route;
    // The worker tells the publisher how many phones are linked; the mock
    // shows one phone joining shortly after the socket goes live so the
    // tray indicator is exercisable in browser dev.
    mockPubSubs = 0;
    window.setTimeout(() => {
      mockPubSubs = 1;
      emitMockEvent("wowsp://gateway-state", {
        role: "pub",
        route,
        phase: "online",
        detail: null,
        subscribers: 1,
      });
    }, 600);
    return null;
  },

  async gateway_publish_status() {
    return {
      enabled: mockGatewayEnabled,
      active: mockPubRoute != null,
      route: mockPubRoute,
      phase: mockPubRoute != null ? "online" : "stopped",
      subscribers: mockPubSubs,
    };
  },

  async gateway_publish_stop() {
    mockPubRoute = null;
    mockPubSubs = 0;
    emitMockEvent("wowsp://gateway-state", {
      role: "pub",
      route: null,
      phase: "stopped",
      detail: null,
    });
    return null;
  },

  async gateway_subscribe_start(args) {
    const root = String(args.root ?? "");
    const route = String(args.route ?? "");
    if (!/^r:[a-z]{2,5}:[0-9]+$/.test(route)) {
      throw rpcError("gateway_subscribe_start", "invalid gateway route");
    }
    const emit = (phase: string, detail?: string) =>
      emitMockEvent("wowsp://gateway-state", { role: "sub", route, phase, detail: detail ?? null });
    emit("resolving");
    await delay(200);
    if (gatewayCaptchaRequired(root) && !args.turnstileToken) {
      emit("captcha");
      throw rpcError("gateway_subscribe_start", "gateway captcha verification failed");
    }
    emit("connecting");
    await delay(300);
    emit("online");
    // Mid-battle catch-up: the channel's retained snapshot + presence.
    mockSubTimers.push(
      window.setTimeout(() => {
        emitMockEvent("wowsp://gateway-battle", mockBattleFrame(route));
        emitMockEvent("wowsp://gateway-battle", { type: "host", online: true });
      }, 500),
    );
    return null;
  },

  async gateway_subscribe_stop() {
    clearMockSubTimers();
    emitMockEvent("wowsp://gateway-battle", { type: "host", online: false });
    emitMockEvent("wowsp://gateway-state", {
      role: "sub",
      route: null,
      phase: "stopped",
      detail: null,
    });
    return null;
  },

  async gateway_selfhost_probe() {
    await delay(200);
    return {
      nodePath: "C:\\MockTools\\node.exe",
      nodeVersion: "v22.14.0",
      npxPath: "C:\\MockTools\\npx.cmd",
      rustc: "rustc 1.86.0",
      wasmTarget: "wasm32-unknown-unknown",
      workerBuild: "worker-build 0.0.14",
      wranglerAuthed: false,
      account: null,
    };
  },

  async gateway_selfhost_step(args) {
    const step = String(args.step ?? "");
    const stream = (stream: "stdout" | "stderr", line: string) =>
      emitMockEvent("wowsp://gateway-selfhost", { step, stream, line });
    let result: Record<string, unknown> = {};
    if (step === "wrangler-login") {
      stream("stdout", "Opening browser for wrangler login…");
      await delay(400);
      stream("stdout", "Successfully logged in.");
      result = { step, account: "mock-account@example.com" };
    } else if (step === "list-zones") {
      stream("stdout", "Listing account zones…");
      await delay(350);
      result = { step, account: "mock-account@example.com" };
    } else if (step === "kv-ensure") {
      stream("stdout", "Ensuring GATEWAY_KV namespace…");
      await delay(350);
      result = { step, kvId: "mock-kv-namespace-id" };
    } else if (step === "deploy") {
      stream("stdout", "Generating wrangler.selfhost.toml…");
      await delay(250);
      stream("stdout", "Running npx wrangler deploy…");
      await delay(600);
      stream("stdout", "Deployed gateway worker.");
      result = { step, url: "https://gateway.example.com/gateway/" };
    } else if (step === "verify") {
      stream("stdout", "Verifying /gateway/health…");
      await delay(400);
      result = {
        step,
        url: "https://gateway.example.com/gateway/",
        health: mockGatewayHealth("https://gateway.example.com/gateway/"),
      };
    } else {
      throw rpcError("gateway_selfhost_step", "unknown selfhost step: " + step);
    }
    emitMockEvent("wowsp://gateway-selfhost", { step, stream: "done", result });
    return result;
  },

  // ── 游玩时间 view's replay-derived battles (static fixture; the ledger
  //    overview itself stays unserved so the empty state is still testable).
  async playtime_battles() {
    return MOCK_BATTLES;
  },

  // Onboarding's local-player discovery: fold the SAME fixture the battle
  // ledger serves, mirroring the Rust aggregation (owned roots only, human
  // recorder names only, battles desc / newest desc / nickname asc) so the
  // wizard's player list is developable in `just dev mock` — MockCaptain
  // (asia) and MockAlt (asia) surface, the nameless Lesta row never does.
  async replay_player_candidates() {
    const tallies = new Map<
      string,
      { realm: string; nickname: string; battles: number; lastDateTime: string | null }
    >();
    for (const b of MOCK_BATTLES.battles) {
      if (!b.kind || !b.realm) continue;
      const name = (b.playerName ?? "").trim();
      // The same isAiName rule the replay rail applies (utils/aiNames; the
      // mock module stays import-free, so the regex is mirrored here).
      if (!name || /^(?::.*:|IDS_.*|#.+)$/.test(name)) continue;
      const key = `${b.realm}\u0000${name}`;
      const hit =
        tallies.get(key) ?? { realm: b.realm, nickname: name, battles: 0, lastDateTime: null };
      hit.battles += 1;
      if (b.dateTime && (!hit.lastDateTime || b.dateTime > hit.lastDateTime)) {
        hit.lastDateTime = b.dateTime;
      }
      tallies.set(key, hit);
    }
    // Nickname ties compare by code units (a < b ? -1 : …), NOT
    // localeCompare — the Rust fold's str::cmp is byte-wise, and a
    // locale-aware collation could head a different row in dev than the
    // real backend answers for CJK/Cyrillic nicknames.
    const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const candidates = [...tallies.values()].sort(
      (a, b) =>
        b.battles - a.battles ||
        byCodeUnits(b.lastDateTime ?? "", a.lastDateTime ?? "") ||
        byCodeUnits(a.nickname, b.nickname),
    );
    return { candidates };
  },

  // Settings → updates: the GitHub mirror ladder + its reachability
  // probe (static fixtures; see MOCK_MIRROR_LADDER above).
  async github_mirror_ladder() {
    return { ...MOCK_MIRROR_LADDER };
  },

  async github_mirror_probe() {
    // One awaited call, like the real command: the backend fans the HEAD
    // requests out and answers once — the mock sleeps once for the shape.
    await delay(600);
    return [...MOCK_MIRROR_LADDER.builtIn, ...MOCK_MIRROR_LADDER.user].reduce<
      Record<string, unknown>[]
    >(
      (rows, prefix) => {
        const hit = MOCK_MIRROR_PROBE[prefix] ?? { ok: false, elapsedMs: 8000, error: "timeout" };
        rows.push({ prefix, ...hit });
        return rows;
      },
      [{ prefix: MOCK_MIRROR_LADDER.official, ...MOCK_MIRROR_PROBE[MOCK_MIRROR_LADDER.official] }],
    );
  },
};
