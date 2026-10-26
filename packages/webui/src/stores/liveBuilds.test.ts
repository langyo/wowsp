import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import type { PlayerBuild } from "@/api";
import {
  BATTLE_MATCH_TOLERANCE_MS,
  parseBattleEpochMs,
  sameBattle,
  useLiveBuildsStore,
} from "./liveBuilds";

function build(name: string | null, ship: number, entity = 1): PlayerBuild {
  const b: PlayerBuild = { entityId: entity, shipParamsId: ship };
  if (name != null) b.name = name;
  return b;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("liveBuilds store", () => {
  it("replaces the replay set per snapshot and clears on a battle change", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyReplayBuilds("battle-a", [build("Alpha", 1), build(null, 2)]);
    expect(store.replayBuilds.length).toBe(2);
    store.applyReplayBuilds("battle-a", [build("Alpha", 1)]);
    expect(store.replayBuilds.length).toBe(1);
    store.beginBattle("battle-b");
    expect(store.replayBuilds).toEqual([]);
    expect(store.probeBuilds.size).toBe(0);
  });

  it("ignores a snapshot for another battle instead of mixing sets", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyReplayBuilds("battle-b", [build("Alpha", 1)]);
    expect(store.battle).toBe("battle-b");
    expect(store.replayBuilds.length).toBe(1);
  });

  it("merges probe frames by name and expires them", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyProbeBuilds({ battle: "battle-a", builds: [build("Alpha", 1)] });
    expect(store.probeBuilds.get("Alpha")).toBeTruthy();
    expect(store.lookup("Alpha", 1)?.source).toBe("probe");
    // Past the freshness gate the probe source lapses even before its timer
    // fires (timer latency must not extend the claimed window).
    vi.advanceTimersByTime(31_000);
    expect(store.lookup("Alpha", 1)).toBeNull();
    // The expiry timer then drops the state outright.
    vi.advanceTimersByTime(5_000);
    expect(store.probeBuilds.size).toBe(0);
  });

  it("ignores probe frames for a different battle", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyProbeBuilds({ battle: "battle-b", builds: [build("Alpha", 1)] });
    expect(store.probeBuilds.size).toBe(0);
  });

  it("prefers fresh probe builds over the replay snapshot", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyReplayBuilds("battle-a", [build("Alpha", 1, 10)]);
    store.applyProbeBuilds({ battle: "battle-a", builds: [build("Alpha", 1, 20)] });
    const hit = store.lookup("Alpha", 1);
    expect(hit?.source).toBe("probe");
    expect(hit?.build.entityId).toBe(20);
  });

  it("falls back to the replay snapshot for players the probe did not name", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyReplayBuilds("battle-a", [build("Bravo", 2, 11)]);
    store.applyProbeBuilds({ battle: "battle-a", builds: [build("Alpha", 1, 20)] });
    const hit = store.lookup("Bravo", 2);
    expect(hit?.source).toBe("replay");
    expect(hit?.build.entityId).toBe(11);
  });

  it("joins an unnamed replay build through a unique ship id", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyReplayBuilds("battle-a", [build(null, 7, 30)]);
    expect(store.lookup("Anyone", 7)?.build.entityId).toBe(30);
    expect(store.lookup("Anyone", 8)).toBeNull();
  });

  it("reset() drops both sources", () => {
    const store = useLiveBuildsStore();
    store.beginBattle("battle-a");
    store.applyReplayBuilds("battle-a", [build("Alpha", 1)]);
    store.applyProbeBuilds({ battle: "battle-a", builds: [build("Alpha", 1)] });
    store.reset();
    expect(store.battle).toBeNull();
    expect(store.replayBuilds).toEqual([]);
    expect(store.probeBuilds.size).toBe(0);
    expect(store.lookup("Alpha", 1)).toBeNull();
  });
});

// The probe spells a battle as its session stamp (epoch ms); the arena file
// as local "YYYYMMDD_HHMMSS". The two must read as the SAME battle within a
// clock-skew tolerance, or every probe frame is dropped as "another battle".
const ARENA = "20261026_162753";
const ARENA_MS = new Date(2026, 9, 26, 16, 27, 53).getTime();
const probeStamp = (offsetMs = 0) => String(ARENA_MS + offsetMs);

describe("battle identity normalization", () => {
  it("parses both spellings to the same instant", () => {
    expect(parseBattleEpochMs(ARENA)).toBe(ARENA_MS);
    expect(parseBattleEpochMs(probeStamp())).toBe(ARENA_MS);
    // A date-only arena stamp (degraded file) parses at local midnight.
    expect(parseBattleEpochMs("20261026")).toBe(new Date(2026, 9, 26).getTime());
    // An epoch-SECONDS stamp is scaled up.
    expect(parseBattleEpochMs(String(Math.floor(ARENA_MS / 1000)))).toBe(
      Math.floor(ARENA_MS / 1000) * 1000,
    );
    expect(parseBattleEpochMs("")).toBeNull();
    expect(parseBattleEpochMs("not-a-time")).toBeNull();
  });

  it("matches the same battle across spellings and keeps a tolerance", () => {
    expect(sameBattle(ARENA, probeStamp())).toBe(true);
    expect(sameBattle(ARENA, probeStamp(30 * 60_000))).toBe(true);
    expect(sameBattle(ARENA, probeStamp(BATTLE_MATCH_TOLERANCE_MS - 1))).toBe(true);
    expect(sameBattle(ARENA, probeStamp(BATTLE_MATCH_TOLERANCE_MS + 1))).toBe(false);
    expect(sameBattle(ARENA, probeStamp(2 * 60 * 60_000))).toBe(false);
    // A missing side stays lenient (the historical contract).
    expect(sameBattle(null, ARENA)).toBe(true);
    expect(sameBattle(ARENA, "")).toBe(true);
    // Unparseable spellings only match verbatim.
    expect(sameBattle("battle-a", "battle-a")).toBe(true);
    expect(sameBattle("battle-a", "battle-b")).toBe(false);
  });

  it("accepts a probe frame for the arena battle under the other spelling", () => {
    const store = useLiveBuildsStore();
    store.beginBattle(ARENA);
    store.applyProbeBuilds({
      battle: probeStamp(),
      builds: [build("Alpha", 1, 20)],
    });
    expect(store.probeBuilds.size).toBe(1);
    expect(store.probeLive()).toBe(true);
    expect(store.lookup("Alpha", 1)?.source).toBe("probe");
  });

  it("keeps probe frames when the arena stamp lands after them", () => {
    const store = useLiveBuildsStore();
    // Probe-first mount: the frame arrives before the roster/battle stamp.
    store.applyProbeBuilds({
      battle: probeStamp(),
      builds: [build("Alpha", 1, 20)],
    });
    store.beginBattle(ARENA);
    expect(store.battle).toBe(ARENA);
    expect(store.probeBuilds.size).toBe(1);
    expect(store.lookup("Alpha", 1)?.source).toBe("probe");
  });

  it("keeps probe frames when the replay snapshot re-spells the same battle", () => {
    const store = useLiveBuildsStore();
    store.applyProbeBuilds({
      battle: probeStamp(),
      builds: [build("Alpha", 1, 20)],
    });
    store.applyReplayBuilds(ARENA, [build("Alpha", 1, 10)]);
    expect(store.replayBuilds.length).toBe(1);
    expect(store.probeBuilds.size).toBe(1);
    expect(store.lookup("Alpha", 1)?.source).toBe("probe");
  });

  it("drops a probe frame from a DIFFERENT battle once the arena is known", () => {
    const store = useLiveBuildsStore();
    store.beginBattle(ARENA);
    store.applyProbeBuilds({
      battle: probeStamp(2 * 60 * 60_000),
      builds: [build("Alpha", 1, 20)],
    });
    expect(store.probeBuilds.size).toBe(0);
    expect(store.lookup("Alpha", 1)).toBeNull();
  });

  it("a real battle change still clears both sources", () => {
    const store = useLiveBuildsStore();
    store.beginBattle(ARENA);
    store.applyProbeBuilds({ battle: probeStamp(), builds: [build("Alpha", 1)] });
    store.applyReplayBuilds(ARENA, [build("Alpha", 1)]);
    // Next battle's arena stamp (one hour later than the tolerance edge).
    const next = "20261026_182753";
    store.beginBattle(next);
    expect(store.replayBuilds).toEqual([]);
    expect(store.probeBuilds.size).toBe(0);
  });
});
