/**
 * Gateway-push state (docs/en/designs/gateway-push.md): the route-entry
 * config (root + the mobile-service toggle), the health-document cache,
 * the desktop publish and phone subscribe phase state machines fed by
 * `wowsp://gateway-state`, the phone's battle-frame state for the live
 * view (`wowsp://gateway-battle`), and the self-host wizard's probe +
 * streamed-step buffers (`wowsp://gateway-selfhost`).
 *
 * The webui never dials a gateway socket: `startPublish` /
 * `startSubscribe` invoke the Rust commands and the phases arrive as
 * events; the TURNSTILE TOKEN always enters through the webui (the widget
 * renders there) — a `captcha` phase (or the `gateway captcha
 * verification failed` rejection) asks the caller to re-enter with a
 * fresh token, bumping the widget's `attempt` so it remints.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import {
  api,
  GATEWAY_OFFICIAL_ROOT,
  type GatewayBattleFrame,
  type GatewayClientConfig,
  type GatewayHealthDoc,
  type GatewayPhase,
  type GatewayPublishStatus,
  type GatewaySelfhostEnv,
  type GatewaySelfhostStep,
  type GatewaySelfhostStepResult,
  type GatewaySelfhostStream,
} from "@/api";
import { parseGatewayBattleEvent } from "@/features/replay/gateway/gatewayBattle";

/** Credentials for one socket-start attempt (either field optional — the
 *  health document says which the node demands). */
export interface GatewayCredentials {
  turnstileToken?: string;
  password?: string;
}

/** One row of the self-host wizard's stream pane. */
export interface SelfhostLogRow {
  step: GatewaySelfhostStep;
  stream: "stdout" | "stderr" | "done";
  line: string;
}

/** localStorage slot for the self-host wizard's wowsp-checkout path — a
 *  plain one-value pref like the account store's active-realm slot. Empty
 *  means "not set" (dev builds auto-probe from the exe's ancestors). */
const SELFHOST_REPO_KEY = "wowsp-selfhost-repo";

function loadSelfhostRepo(): string {
  try {
    return localStorage.getItem(SELFHOST_REPO_KEY) ?? "";
  } catch {
    return "";
  }
}

export const useGatewayStore = defineStore("gateway", () => {
  // ── route-entry config (persisted by Rust; both builds) ────────────────
  const config = ref<GatewayClientConfig>({
    root: GATEWAY_OFFICIAL_ROOT,
    enabled: false,
  });
  const configLoaded = ref(false);
  const configBusy = ref(false);
  const configError = ref<string | null>(null);
  /** Whether the configured root is a CUSTOM node (self-host) — failures
   *  there surface as toasts (the official node's are inline status). */
  const isCustomRoot = computed(
    () => config.value.root.replace(/\/+$/, "") !== GATEWAY_OFFICIAL_ROOT.replace(/\/+$/, ""),
  );

  async function loadConfig(): Promise<void> {
    configBusy.value = true;
    configError.value = null;
    try {
      config.value = await api.gatewayGetConfig();
      configLoaded.value = true;
    } catch (e) {
      configError.value = e instanceof Error ? e.message : String(e);
    } finally {
      configBusy.value = false;
    }
  }

  /** Patch the config; resolves with the NORMALIZED config Rust stored
   *  (a custom root may come back trailing-slash-folded or rejected). */
  async function saveConfig(patch: { root?: string; enabled?: boolean }): Promise<GatewayClientConfig> {
    configBusy.value = true;
    configError.value = null;
    try {
      config.value = await api.gatewaySetConfig(patch);
      configLoaded.value = true;
      return config.value;
    } catch (e) {
      configError.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      configBusy.value = false;
    }
  }

  // ── health cache (per root; 60 s edge cache server-side) ───────────────
  const healthByRoot = ref<Record<string, GatewayHealthDoc | null>>({});
  const healthBusyRoot = ref<string | null>(null);

  /** Resolve `{root}/health` through Rust with a per-root memory cache
   *  (force re-resolves). Resolves null on failure — callers read the
   *  stable rejection markers from the thrown error instead; this cache
   *  only ever holds SUCCESSFUL docs. */
  async function resolveHealth(root: string, force = false): Promise<GatewayHealthDoc> {
    const key = root.replace(/\/+$/, "");
    if (!force && key in healthByRoot.value) {
      const hit = healthByRoot.value[key];
      if (hit) return hit;
    }
    healthBusyRoot.value = key;
    try {
      const doc = await api.gatewayGetHealth(root);
      healthByRoot.value = { ...healthByRoot.value, [key]: doc };
      return doc;
    } finally {
      healthBusyRoot.value = null;
    }
  }

  // ── socket phases (wowsp://gateway-state, both roles) ──────────────────
  const pubPhase = ref<GatewayPhase>("stopped");
  const pubDetail = ref<string | null>(null);
  /** Phones linked to the publisher's channel right now (the worker's
   *  host-only `subs` telemetry; 0 while none). The tray's phone-linked
   *  indicator reads this. */
  const pubSubscribers = ref(0);
  const subPhase = ref<GatewayPhase>("stopped");
  const subDetail = ref<string | null>(null);

  // ── battle frames (wowsp://gateway-battle, phone) ──────────────────────
  /** The latest battle frame (kept after `bye` so the ended roster stays
   *  rendered for review, exactly like the local view's retention). */
  const battle = ref<GatewayBattleFrame | null>(null);
  /** The channel's last battle ended (`bye`) — the waiting/ended hint. */
  const battleEnded = ref(false);
  /** Desktop presence on the channel (null before the first host frame). */
  const hostOnline = ref<boolean | null>(null);

  function applyBattleEvent(raw: unknown): void {
    const frame = parseGatewayBattleEvent(raw);
    if (!frame) return;
    if (frame.type === "battle") {
      battle.value = frame;
      battleEnded.value = false;
    } else if (frame.type === "bye") {
      battleEnded.value = true;
    } else {
      hostOnline.value = frame.online;
    }
  }

  /** Reset the battle state (a fresh subscribe pass starts clean). */
  function clearBattle(): void {
    battle.value = null;
    battleEnded.value = false;
    hostOnline.value = null;
  }

  // ── publish socket (desktop) ───────────────────────────────────────────
  /** The route the CURRENT publish attempt serves (kept for the captcha
   *  re-entry: the tooltip hands the fresh token to the same route). */
  const pubRoute = ref<string | null>(null);

  /** Start (or re-enter with fresh credentials) the desktop publisher.
   *  Rejects with the contract's stable markers — the `captcha` phase
   *  event (or the captcha-failed marker) is the caller's cue to collect
   *  a new token and call again. */
  async function startPublish(
    route: string,
    creds?: GatewayCredentials,
  ): Promise<void> {
    pubRoute.value = route;
    pubPhase.value = "resolving";
    pubDetail.value = null;
    await api.gatewayPublishStart({ route, ...creds });
  }

  async function stopPublish(): Promise<void> {
    try {
      await api.gatewayPublishStop();
    } finally {
      pubPhase.value = "stopped";
      pubDetail.value = null;
      pubSubscribers.value = 0;
    }
  }

  /// Snapshot the publisher's link state from Rust. A surface that mounts
  /// LATE (the tray panel opens long after the transitions) needs this;
  /// `wowsp://gateway-state` only carries what happens while listening.
  /// The service toggle is synced too: the tray webview stays mounted
  /// across show/hide, so a toggle made in the settings window would
  /// otherwise never reach it.
  async function refreshPublishStatus(): Promise<GatewayPublishStatus | null> {
    try {
      const status = await api.gatewayPublishStatus();
      config.value.enabled = status.enabled;
      pubPhase.value = status.phase;
      pubSubscribers.value = status.subscribers;
      if (status.route) pubRoute.value = status.route;
      return status;
    } catch {
      return null;
    }
  }

  // ── subscribe socket (phone) ───────────────────────────────────────────
  const subRoute = ref<string | null>(null);

  async function startSubscribe(
    root: string,
    route: string,
    creds?: GatewayCredentials,
  ): Promise<void> {
    subRoute.value = route;
    subPhase.value = "connecting";
    subDetail.value = null;
    await api.gatewaySubscribeStart({ root, route, ...creds });
  }

  async function stopSubscribe(): Promise<void> {
    try {
      await api.gatewaySubscribeStop();
    } finally {
      subPhase.value = "stopped";
      subDetail.value = null;
    }
  }

  // ── self-host wizard (desktop) ─────────────────────────────────────────
  const selfhostEnv = ref<GatewaySelfhostEnv | null>(null);
  /** The wizard's wowsp-checkout path (persisted one-slot pref; empty =
   *  not set — dev builds auto-probe). Written through setSelfhostRepo. */
  const selfhostRepo = ref(loadSelfhostRepo());

  function setSelfhostRepo(raw: string): void {
    const v = raw.trim();
    selfhostRepo.value = v;
    try {
      if (v) localStorage.setItem(SELFHOST_REPO_KEY, v);
      else localStorage.removeItem(SELFHOST_REPO_KEY);
    } catch {
      // Storage unavailable (private mode &c.) — the session value still
      // serves this wizard run.
    }
  }
  const selfhostProbing = ref(false);
  /** Log rows for the wizard's stream pane (every step's lines, in order,
   *  tagged with their step so the pane can render separators). */
  const selfhostLog = ref<SelfhostLogRow[]>([]);
  const selfhostStepBusy = ref<GatewaySelfhostStep | null>(null);
  /** The last completed step's result (deploy URL / zones / KV id). */
  const selfhostResult = ref<GatewaySelfhostStepResult | null>(null);

  async function probeSelfhost(): Promise<GatewaySelfhostEnv | null> {
    selfhostProbing.value = true;
    try {
      selfhostEnv.value = await api.gatewaySelfhostProbe();
      return selfhostEnv.value;
    } catch {
      selfhostEnv.value = null;
      return null;
    } finally {
      selfhostProbing.value = false;
    }
  }

  /** Run one wizard step (args forwarded verbatim — domain / kvId /
   *  repoDir, empty fields omitted by the caller), buffering its streamed
   *  lines; resolves with the step's done result (or the invoke rejection
   *  — the log keeps whatever streamed before the failure). */
  async function runSelfhostStep(
    step: GatewaySelfhostStep,
    args?: { domain?: string; kvId?: string; repoDir?: string },
  ): Promise<GatewaySelfhostStepResult> {
    selfhostStepBusy.value = step;
    try {
      const result = await api.gatewaySelfhostStep(step, args);
      selfhostResult.value = result;
      return result;
    } finally {
      selfhostStepBusy.value = null;
    }
  }

  function clearSelfhostLog(): void {
    selfhostLog.value = [];
    selfhostResult.value = null;
  }

  // ── event wiring (once per app; mirrors the pairing store) ─────────────
  let wired = false;

  function wireEvents(): void {
    if (wired) return;
    wired = true;
    const unState = api.listenGatewayState?.((s) => {
      if (s.role === "pub") {
        pubPhase.value = s.phase;
        pubDetail.value = s.detail ?? null;
        if (typeof s.subscribers === "number") pubSubscribers.value = s.subscribers;
        else if (s.phase === "stopped") pubSubscribers.value = 0;
      } else {
        subPhase.value = s.phase;
        subDetail.value = s.detail ?? null;
      }
    });
    if (unState instanceof Promise) void unState.catch(() => {});
    const unBattle = api.listenGatewayBattle?.((f) => applyBattleEvent(f));
    if (unBattle instanceof Promise) void unBattle.catch(() => {});
    const unSelfhost = api.listenGatewaySelfhost?.((s: GatewaySelfhostStream) => {
      if (s.stream === "done") {
        selfhostLog.value = [
          ...selfhostLog.value,
          { step: s.step, stream: "done", line: "" },
        ];
        return;
      }
      selfhostLog.value = [
        ...selfhostLog.value,
        { step: s.step, stream: s.stream, line: s.line ?? "" },
      ];
    });
    if (unSelfhost instanceof Promise) void unSelfhost.catch(() => {});
  }

  wireEvents();

  return {
    // config
    config,
    configLoaded,
    configBusy,
    configError,
    isCustomRoot,
    loadConfig,
    saveConfig,
    // health
    healthByRoot,
    healthBusyRoot,
    resolveHealth,
    // phases
    pubPhase,
    pubDetail,
    pubSubscribers,
    refreshPublishStatus,
    subPhase,
    subDetail,
    // publish (desktop)
    pubRoute,
    startPublish,
    stopPublish,
    // subscribe (phone)
    subRoute,
    startSubscribe,
    stopSubscribe,
    // battle frames (phone)
    battle,
    battleEnded,
    hostOnline,
    clearBattle,
    // selfhost wizard (desktop)
    selfhostEnv,
    selfhostRepo,
    setSelfhostRepo,
    selfhostProbing,
    selfhostLog,
    selfhostStepBusy,
    selfhostResult,
    probeSelfhost,
    runSelfhostStep,
    clearSelfhostLog,
  };
});
