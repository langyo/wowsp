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
/** Battle-identity match tolerance. The two sources spell the same battle
 *  differently — the probe frame carries its session stamp as epoch
 *  milliseconds, the arena file's dateTime as local "YYYYMMDD_HHMMSS" — so
 *  the comparison parses both to an instant and allows clock skew between
 *  the two writers (the arena file is stamped at battle load, the probe
 *  session a few seconds later; a minute is ample, an hour keeps a
 *  mis-parsed/edge format from reading a NEW battle as the same one). */
export const BATTLE_MATCH_TOLERANCE_MS = 60 * 60 * 1000;

/** Parse one battle stamp into epoch milliseconds, or null when the spelling
 *  is not a recognized timestamp (the caller then falls back to exact
 *  string equality). Accepted spellings:
 *
 *  - the probe session stamp: bare epoch milliseconds ("1758870000000"; a
 *    10-11 digit value is read as epoch seconds),
 *  - the arena tempArenaInfo dateTime: local "YYYYMMDD_HHMMSS" (and the
 *    date-only "YYYYMMDD" a degraded file may carry),
 *  - anything else Date.parse understands (ISO-8601 etc.) as a safety net.
 *
 *  "Local" matches the arena file's writer: the game stamps the battle in
 *  the machine's local time zone, so the frontend parses it the same way. */
export function parseBattleEpochMs(stamp: string | null | undefined): number | null {
  const value = (stamp ?? "").trim();
  if (!value) return null;
  const local = (year: string, month: string, day: string, hour = "0", minute = "0", second = "0") => {
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  };
  if (/^[0-9]+$/.test(value)) {
    // Compact local stamps: YYYYMMDD (date only) or YYYYMMDDHHMMSS — the
    // arena file's timestamp family, parsed before the bare-epoch branch
    // (an 8-digit value would otherwise read as an absurd epoch).
    if (value.length === 8) return local(value.slice(0, 4), value.slice(4, 6), value.slice(6, 8));
    if (value.length === 14) {
      return local(
        value.slice(0, 4),
        value.slice(4, 6),
        value.slice(6, 8),
        value.slice(8, 10),
        value.slice(10, 12),
        value.slice(12, 14),
      );
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // 13-digit values are milliseconds; a seconds stamp is scaled up.
    return n < 1e12 ? n * 1000 : n;
  }
  const arena = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (arena) {
    const [, year, month, day, hour, minute, second] = arena;
    return local(year, month, day, hour, minute, second);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whether two battle stamps name the SAME battle. A missing side keeps the
 *  historical lenient contract (the frame is accepted); two parseable stamps
 *  compare within {@link BATTLE_MATCH_TOLERANCE_MS}; unparseable spellings
 *  only match verbatim. */
export function sameBattle(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = (a ?? "").trim();
  const right = (b ?? "").trim();
  if (!left || !right) return true;
  const leftMs = parseBattleEpochMs(left);
  const rightMs = parseBattleEpochMs(right);
  if (leftMs != null && rightMs != null) {
    return Math.abs(leftMs - rightMs) <= BATTLE_MATCH_TOLERANCE_MS;
  }
  return left === right;
}

/**
 * Ally ship-build store for /live: the ONE consumer surface that merges the
 * two build sources behind a per-player lookup.
 *
 * - replay: the live temp-replay snapshot (stores/liveSelf.ts) — each decoded
 *   snapshot REPLACES the set (the create-state loadout is static per battle,
 *   so the newest decode is complete truth),
 * - probe: the in-game bridge (event wowsp://ingame-builds + the
 *   ingame_builds_snapshot catch-up command) — a live stream merged by
 *   player name, expiring on its own freshness window.
 *
 * Enemy builds never enter this store: the Rust IPC exit filters the decode
 * to relation <= 1 before the webui sees anything, and this store has no
 * enemy input path at all.
 *
 * Battle lifecycle: a new arena dateTime (or a session reset from
 * useLiveSessionGuard) wipes both sources; the store never carries a
 * previous battle's loadout into the next one. The two sources spell the
 * battle id differently, so every comparison goes through sameBattle()
 * (parsed instants, tolerance) instead of string equality.
 */
export const useLiveBuildsStore = defineStore("liveBuilds", () => {
  /** Arena battle stamp the current builds belong to (the canonical spelling;
   *  the probe's epoch-ms spelling is kept in probeBattle next to its set). */
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

  function clearSources(): void {
    replayBuilds.value = [];
    clearProbe();
  }

  function reset(): void {
    battle.value = null;
    clearSources();
  }

  /** Arm a battle (arena dateTime). The SAME battle re-spelled (the probe
   *  already reported it under its epoch-ms id) keeps both sources; a real
   *  change or a clear drops them. */
  function beginBattle(stamp: string | null): void {
    if (stamp === battle.value) return;
    if (battle.value == null) {
      // First arm of this session: keep any probe frames that landed first
      // (the panel pulls the snapshot before the roster may arrive).
      battle.value = stamp;
      return;
    }
    if (stamp == null) {
      battle.value = null;
      clearSources();
      return;
    }
    if (sameBattle(battle.value, stamp)) {
      // Same battle, other spelling: re-stamp and keep the sets.
      battle.value = stamp;
      return;
    }
    battle.value = stamp;
    clearSources();
  }

  /** Replace the replay-sourced set with one live snapshot's ally builds.
   *  Callers pass only non-empty sets (an early snapshot without create
   *  states must not blank a later good one). */
  function applyReplayBuilds(
    stamp: string,
    builds: readonly PlayerBuild[] | null | undefined,
  ): void {
    if (!stamp) return;
    if (battle.value == null) battle.value = stamp;
    else if (!sameBattle(battle.value, stamp)) beginBattle(stamp);
    else battle.value = stamp;
    replayBuilds.value = builds ? builds.slice() : [];
  }

  /** Merge one probe frame. A frame for ANOTHER battle is ignored (the arena
   *  stamp plus the battle reset own the transition); the same battle in the
   *  probe's epoch-ms spelling is accepted against the arena's dateTime
   *  spelling through sameBattle(). Frames carry a name for every build (the
   *  probe reads the live roster), so the merge is keyed by name. */
  function applyProbeBuilds(
    payload: { battle?: string | null; builds?: readonly PlayerBuild[] | null } | null | undefined,
  ): void {
    if (!payload || !payload.battle) return;
    const frameBattle = payload.battle.trim();
    if (!frameBattle) return;
    if (!payload.builds || payload.builds.length === 0) return;
    if (battle.value != null && !sameBattle(battle.value, frameBattle)) return;
    const next = new Map<string, PlayerBuild>();
    for (const build of payload.builds) {
      if (build.name) next.set(build.name, build);
    }
    if (next.size === 0) return;
    probeBuilds.value = next;
    probeBattle.value = frameBattle;
    probeAt.value = Date.now();
    if (expiry) clearTimeout(expiry);
    expiry = setTimeout(() => {
      expiry = null;
      probeAt.value = 0;
      probeBattle.value = null;
      probeBuilds.value = new Map();
    }, PROBE_TTL_MS + PROBE_EXPIRY_SLACK_MS);
  }

  /** Whether the probe source is live: fresh frame AND the same battle as the
   *  arena (both comparisons lenient while a stamp is still missing). */
  function probeLive(): boolean {
    if (probeAt.value <= 0) return false;
    if (Date.now() - probeAt.value > PROBE_TTL_MS) return false;
    return sameBattle(battle.value, probeBattle.value);
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
    probeLive,
    lookup,
  };
});
