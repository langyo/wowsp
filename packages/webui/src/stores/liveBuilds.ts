import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";

import type { PlayerBuild } from "@/api";
import { joinPlayerBuild } from "@/features/replay/playerBuild";

/** Which source a displayed build came from (the card's source badge). */
export type BuildSource = "replay" | "probe";

/** A joined build ready for the view-model translation. */
export interface BuildHit {
  build: PlayerBuild;
  source: BuildSource;
}

/** Freshness window of a probe frame — the in-game bridge rewrites its
 *  payload on every change; a stream that stopped (battle over, client quit)
 *  must not pin a build forever (same 30 s gate as ingame telemetry). */
const PROBE_TTL_MS = 30_000;
/** Timer re-arms past the strict gate so a frame is never dropped a tick
 *  early by timer jitter. */
const PROBE_EXPIRY_SLACK_MS = 5_000;

/**
 * Ally ship-build store for /live: the ONE consumer surface that merges the
 * two build sources behind a per-player lookup.
 *
 * - replay: the live temp-replay snapshot (stores/liveSelf.ts) — each decoded
 *   snapshot REPLACES the set (the create-state loadout is static per battle,
 *   so the newest decode is complete truth),
 * - probe: the PR-2 in-game bridge event (wowsp://ingame-builds) — a live
 *   stream merged by player name, expiring on its own freshness window.
 *
 * Enemy builds never enter this store: the Rust IPC exit filters the decode
 * to relation <= 1 before the webui sees anything, and this store has no
 * enemy input path at all.
 *
 * Battle lifecycle: a new arena dateTime (or a session reset from
 * useLiveSessionGuard) wipes both sources; the store never carries a
 * previous battle's loadout into the next one.
 */
export const useLiveBuildsStore = defineStore("liveBuilds", () => {
  /** Battle stamp the current builds belong to (arena dateTime). */
  const battle = ref<string | null>(null);
  /** Latest live-temp-replay snapshot's ally builds (named + anonymous). */
  const replayBuilds = shallowRef<PlayerBuild[]>([]);
  /** Fresh probe-sourced builds keyed by player name (probe always names). */
  const probeBuilds = shallowRef<Map<string, PlayerBuild>>(new Map());
  const probeBattle = ref<string | null>(null);
  const probeAt = ref(0);
  let expiry: ReturnType<typeof setTimeout> | null = null;

  function clearProbe(): void {
    if (expiry) {
      clearTimeout(expiry);
      expiry = null;
    }
    probeAt.value = 0;
    probeBattle.value = null;
    probeBuilds.value = new Map();
  }

  function reset(): void {
    battle.value = null;
    replayBuilds.value = [];
    clearProbe();
  }

  /** Arm a battle (arena dateTime). A different stamp drops every source —
   *  the retention rule keeps the ENDED battle's roster on screen with the
   *  same stamp, so this only fires on a real battle change or a clear. */
  function beginBattle(stamp: string | null): void {
    if (stamp === battle.value) return;
    battle.value = stamp;
    replayBuilds.value = [];
    clearProbe();
  }

  /** Replace the replay-sourced set with one live snapshot's ally builds.
   *  Callers pass only non-empty sets (an early snapshot without create
   *  states must not blank a later good one). */
  function applyReplayBuilds(
    stamp: string,
    builds: readonly PlayerBuild[] | null | undefined,
  ): void {
    if (!stamp) return;
    if (battle.value != null && battle.value !== stamp) beginBattle(stamp);
    else if (battle.value == null) battle.value = stamp;
    replayBuilds.value = builds ? builds.slice() : [];
  }

  /** Merge one probe frame (PR-2 event). A frame for another battle is
   *  ignored: the replay source plus the battle reset own that transition.
   *  Frames carry a name for every build (the probe reads the live roster),
   *  so the merge is keyed by name. */
  function applyProbeBuilds(
    payload: { battle?: string | null; builds?: readonly PlayerBuild[] | null } | null | undefined,
  ): void {
    if (!payload || !payload.battle) return;
    if (battle.value != null && battle.value !== payload.battle) return;
    if (!payload.builds || payload.builds.length === 0) return;
    if (battle.value == null) battle.value = payload.battle;
    const next = new Map<string, PlayerBuild>();
    for (const build of payload.builds) {
      if (build.name) next.set(build.name, build);
    }
    if (next.size === 0) return;
    probeBuilds.value = next;
    probeBattle.value = payload.battle;
    probeAt.value = Date.now();
    if (expiry) clearTimeout(expiry);
    expiry = setTimeout(() => {
      expiry = null;
      probeAt.value = 0;
      probeBattle.value = null;
      probeBuilds.value = new Map();
    }, PROBE_TTL_MS + PROBE_EXPIRY_SLACK_MS);
  }

  /** Whether the probe source is live (fresh frame for this battle). The
   *  battle-id comparison is skipped while either side has no stamp yet —
   *  PR-2's bridge spellings are not normalized until that source lands. */
  function probeLive(): boolean {
    if (probeAt.value <= 0) return false;
    if (Date.now() - probeAt.value > PROBE_TTL_MS) return false;
    if (battle.value == null || probeBattle.value == null) return true;
    return probeBattle.value === battle.value;
  }

  /** Join one roster row to its build: probe first (live ground truth), then
   *  the replay snapshot (name first, unique-shipId fallback). Null means
   *  "show no loadout" — the card falls back to the ship spec alone. */
  function lookup(
    name: string | null | undefined,
    shipId: number | null | undefined,
  ): BuildHit | null {
    if (probeLive() && name) {
      const build = probeBuilds.value.get(name);
      if (build) return { build, source: "probe" };
    }
    const replay = joinPlayerBuild(replayBuilds.value, name, shipId);
    if (replay) return { build: replay, source: "replay" };
    return null;
  }

  return {
    battle,
    replayBuilds,
    probeBuilds,
    probeBattle,
    probeAt,
    reset,
    beginBattle,
    applyReplayBuilds,
    applyProbeBuilds,
    lookup,
  };
});
