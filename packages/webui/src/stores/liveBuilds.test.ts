import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import type { PlayerBuild } from "@/api";
import { useLiveBuildsStore } from "./liveBuilds";

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
