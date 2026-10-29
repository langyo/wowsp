/** Gateway-push domain of the WoWSP API client: the account-routed
 *  battle channel of docs/en/designs/gateway-push.md — route-entry config,
 *  the `{entry}/health` + `/session` exchange, the desktop publish socket
 *  and the phone subscribe socket (both owned by Rust; the webui never
 *  dials a gateway WebSocket), and the self-host wizard's probe/step
 *  surface (composed into `api` by client.ts).
 *
 *  Every shape below mirrors the pinned IPC contract §9 (camelCase serde on
 *  the Rust side); the error markers quoted in the command comments are the
 *  EXACT rejection strings the Rust commands emit, so UI code may match on
 *  them verbatim. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** The official deployment's route entry (the normalized default `root` —
 *  same constant as the Rust side's; a custom root may replace it in
 *  config). All gateway endpoints are relative to this base URL. */
export const GATEWAY_OFFICIAL_ROOT = "https://wowsp.langyo.xyz/gateway/";

/** Channel-id shape `r:<realm>:<accountId>` of the PLAYING account (§2).
 *  Opaque ASCII — validated, never interpreted beyond routing. */
export const GATEWAY_ROUTE_RE = /^r:[a-z]{2,5}:[0-9]+$/;

/** `gateway_get_config` / `gateway_set_config` payload. Mirrors
 *  `wowsp_tauri_shared::GatewayClientConfig` (packages/app/tauri_shared/
 *  src/gateway.rs). `root` is the NORMALIZED route entry; `enabled` is
 *  the persisted mobile-service toggle. */
export interface GatewayClientConfig {
  root: string;
  enabled: boolean;
}

/** `{entry}/health` deployment document (§3.1), fetched through the
 *  `gateway_get_health` Rust command (the webui does no cross-origin
 *  fetches). Mirrors `wowsp_tauri_shared::GatewayHealthDoc`. */
export interface GatewayHealthDoc {
  /** Protocol generation, `"v1"`. */
  gateway: string;
  /** Minimum app version the node will serve (relay version-gate
   *  semantics); absent in legacy docs. */
  minClientVersion?: string | null;
  auth: {
    turnstile: {
      required: boolean;
      /** Turnstile sitekey — present when required (the captcha widget's
       *  async-sitekey guard mounts on it). */
      sitekey?: string | null;
    };
    password: { required: boolean };
  };
  /** Free-form operator notice (surfaced as small print, not a modal). */
  notice?: string | null;
}

/** `gateway_open_session` success — the single-use ticket consumed at the
 *  first WS upgrade (≤120 s TTL). */
export interface GatewaySessionTicket {
  ticket: string;
  ttl: number;
}

/** Socket lifecycle phases on `wowsp://gateway-state` (§9). */
export type GatewayPhase =
  | "resolving"
  | "captcha"
  | "connecting"
  | "online"
  | "error"
  | "stopped";

/** `wowsp://gateway-state` payload — desktop (role "pub") and phone
 *  (role "sub") alike. The `captcha` phase re-arms whenever the exchange
 *  needs a FRESH turnstile token (the token always enters through the
 *  webui's widget; Rust only exchanges it). */
export interface GatewayStateEvent {
  role: "pub" | "sub";
  route?: string | null;
  phase: GatewayPhase;
  /** English marker/detail sentence (health error markers, retry-after…). */
  detail?: string | null;
}

/** One roster entry inside a battle frame — the exact `VehicleEntry` wire
 *  shape (relation 0 = self, 1 = ally, 2+ = enemy; teams derive from it,
 *  exactly like the local arena roster). */
export interface GatewayVehicleEntry {
  id: number;
  name: string;
  relation: number;
  shipId: number;
  shipName?: string | null;
}

/** `{"type":"battle",…}` — the ArenaInfo head + VehicleEntry fields 1:1
 *  (minus `raw`), so the phone maps the frame into its roster store
 *  without translation (§3.3). */
export interface GatewayBattleFrame {
  type: "battle";
  realm: string;
  route: string;
  self: { name: string; accountId?: number | null };
  battle: {
    dateTime?: string | null;
    matchGroup?: string | null;
    mapName?: string | null;
    scenario?: string | null;
    eventType?: string | null;
    botCount?: number | null;
    scriptedUnitCount?: number | null;
    vehicles: GatewayVehicleEntry[];
  };
}

/** `{"type":"host","online":…}` — desktop presence on the channel. */
export interface GatewayHostFrame {
  type: "host";
  online: boolean;
}

/** `{"type":"bye"}` — the battle ended (game exit / roster clear). */
export interface GatewayByeFrame {
  type: "bye";
}

/** Every frame the `wowsp://gateway-battle` event may carry (§3.3: the
 *  battle snapshot plus the channel's presence/end frames — forwarded
 *  raw). Unknown `type` values are ignored by the parser. */
export type GatewayBattleEvent = GatewayBattleFrame | GatewayHostFrame | GatewayByeFrame;

/** `gateway_selfhost_probe` result (§9). Absent fields = the piece was
 *  not found on PATH. */
export interface GatewaySelfhostEnv {
  nodePath?: string | null;
  nodeVersion?: string | null;
  npxPath?: string | null;
  rustc?: string | null;
  wasmTarget?: string | null;
  workerBuild?: string | null;
  wranglerAuthed: boolean;
  account?: string | null;
}

/** `gateway_selfhost_step` step selector (§9). */
export type GatewaySelfhostStep =
  | "wrangler-login"
  | "list-zones"
  | "kv-ensure"
  | "deploy"
  | "verify";

/** `gateway_selfhost_step` result — which step ran plus the fields that
 *  step produces (`kvId` for kv-ensure, `url`/`health` for deploy/verify,
 *  `account` for the login/zones steps). Mirrors
 *  `wowsp_tauri_shared::SelfhostStepResult`. */
export interface GatewaySelfhostStepResult {
  step: string;
  kvId?: string | null;
  url?: string | null;
  health?: GatewayHealthDoc | null;
  account?: string | null;
}

/** One `wowsp://gateway-selfhost` stream chunk: `line` on stdout/stderr
 *  chunks, `result` (and no line) on the step's done marker. */
export interface GatewaySelfhostStream {
  step: GatewaySelfhostStep;
  stream: "stdout" | "stderr" | "done";
  line?: string | null;
  result?: GatewaySelfhostStepResult | null;
}

export const gatewayApi = {
  // ── Route-entry config (persisted both builds) ─────────────────────────
  /** Current gateway client config (root + the mobile-service toggle). */
  gatewayGetConfig: () =>
    transport.invoke<GatewayClientConfig>(RPC.gateway_get_config),
  /** Patch the config (either field optional). `root` is validated by the
   *  relay URL policy (https enforced, loopback allowed for dev) and comes
   *  back NORMALIZED. */
  gatewaySetConfig: (patch: { root?: string; enabled?: boolean }) =>
    transport.invoke<GatewayClientConfig>(RPC.gateway_set_config, patch),

  // ── Health + session exchange (§3.1/§3.2) ──────────────────────────────
  /** Fetch `{root}/health` through Rust. Rejects with the stable markers
   *  `gateway unreachable or health document invalid` |
   *  `gateway speaks an unsupported gateway protocol` |
   *  `gateway requires a newer app version`. */
  gatewayGetHealth: (root: string) =>
    transport.invoke<GatewayHealthDoc>(RPC.gateway_get_health, { root }),
  /** Exchange credentials for a single-use ticket. Rejects with
   *  `gateway captcha verification failed` |
   *  `gateway password rejected` |
   *  `gateway rate limited, retry after Ns`. */
  gatewayOpenSession: (args: {
    root: string;
    route: string;
    turnstileToken?: string;
    password?: string;
  }) =>
    transport.invoke<GatewaySessionTicket>(RPC.gateway_open_session, args),

  // ── Sockets (Rust-owned; phases arrive on wowsp://gateway-state) ───────
  /** Desktop publisher. `route` is derived by the caller (webui) from the
   *  session hub; a captcha phase on the state event asks for a fresh
   *  `turnstileToken` on the NEXT call. */
  gatewayPublishStart: (args: { route: string; turnstileToken?: string; password?: string }) =>
    transport.invoke<null>(RPC.gateway_publish_start, args),
  gatewayPublishStop: () => transport.invoke<null>(RPC.gateway_publish_stop),
  /** Phone subscriber (root explicit — the phone's configured entry). */
  gatewaySubscribeStart: (args: {
    root: string;
    route: string;
    turnstileToken?: string;
    password?: string;
  }) => transport.invoke<null>(RPC.gateway_subscribe_start, args),
  gatewaySubscribeStop: () => transport.invoke<null>(RPC.gateway_subscribe_stop),

  // ── Self-host wizard (desktop; §7/§9) ──────────────────────────────────
  gatewaySelfhostProbe: () =>
    transport.invoke<GatewaySelfhostEnv>(RPC.gateway_selfhost_probe),
  /** Run one wizard step. `domain` (target step onward), `kvId` (deploy —
   *  the kv step's namespace id) and `repoDir` (the local wowsp checkout
   *  the worker sources deploy from — dev builds auto-probe from the
   *  exe's ancestors, installed builds cannot, so the wizard asks) are
   *  all optional; EMPTY/absent fields are omitted from the IPC args so
   *  Rust's auto-probe keeps working. */
  gatewaySelfhostStep: (
    step: GatewaySelfhostStep,
    args?: { domain?: string; kvId?: string; repoDir?: string },
  ) =>
    transport.invoke<GatewaySelfhostStepResult>(RPC.gateway_selfhost_step, {
      step,
      ...args,
    }),

  // ── Event streams ──────────────────────────────────────────────────────
  /** Socket lifecycle (both roles). */
  listenGatewayState: (handler: (s: GatewayStateEvent) => void) =>
    transport.listen?.<GatewayStateEvent>("wowsp://gateway-state", handler),
  /** Phone battle frames (battle snapshot + host/bye presence, raw). */
  listenGatewayBattle: (handler: (f: GatewayBattleEvent) => void) =>
    transport.listen?.<GatewayBattleEvent>("wowsp://gateway-battle", handler),
  /** Wizard streamed output. */
  listenGatewaySelfhost: (handler: (s: GatewaySelfhostStream) => void) =>
    transport.listen?.<GatewaySelfhostStream>("wowsp://gateway-selfhost", handler),
};
