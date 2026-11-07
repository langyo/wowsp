/** Post-battle AI confidence math: the name join off the E25 static report
 * and the coverage-weighted sort key (the user's rule: the observable-time
 * ratio is the AI weight; the remainder rides the settlement-XP share of
 * the row's own team). */
import { describe, expect, it } from "vitest";

import type { StaticReport, StaticRosterEntry } from "@/api/modules/decision";
import {
  aiRecorderEntryOf,
  aiScoreMapOf,
  aiWeightedKey,
  formatAiPct,
  type AiScoreEntry,
} from "./postBattleAiScore";

const entry = (over: Partial<AiScoreEntry>): AiScoreEntry => ({
  teamId: 0,
  isRecorder: false,
  wholeGame: 0.7,
  wholeFire: 0.65,
  wholeMove: 0.8,
  coverage: 1,
  ...over,
});

const rosterEntry = (over: Partial<StaticRosterEntry>): StaticRosterEntry => ({
  entityId: 1,
  shipId: null,
  shipClass: null,
  fireApplicable: true,
  name: null,
  playerName: "Alpha",
  teamId: 0,
  isRecorder: false,
  diedAt: null,
  coverage: { aliveFrom: 0, aliveTo: 600, samples: 150, gapSeconds: 0, completeness: 1, gapSegments: [] },
  whole: { wholeGame: 0.7, wholeFire: 0.65, wholeMove: 0.8, contribution: null, contributionShots: null },
  outcome: null,
  ...over,
});

const report = (roster: StaticRosterEntry[]): StaticReport =>
  ({
    replayPath: "replay.wowsreplay",
    replayId: "r",
    mapName: null,
    gameMode: null,
    durationS: 600,
    losLoaded: true,
    modelSources: { fire: "pack", moveModel: "pack" },
    entityId: 1,
    roster,
    timeline: [],
    moments: [],
  }) as unknown as StaticReport;

describe("aiScoreMapOf", () => {
  it("joins by playerName and drops unscoreable or unnamed entries", () => {
    const map = aiScoreMapOf(
      report([
        rosterEntry({ entityId: 1, playerName: "Alpha" }),
        rosterEntry({ entityId: 2, playerName: "Beta", whole: null }),
        rosterEntry({ entityId: 3, playerName: null }),
      ]),
    );
    expect(map.has("Alpha")).toBe(true);
    expect(map.has("Beta")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("clamps out-of-range wire values into [0, 1]", () => {
    const map = aiScoreMapOf(
      report([
        rosterEntry({
          whole: { wholeGame: 1.4, wholeFire: null, wholeMove: -0.2, contribution: null, contributionShots: null },
          coverage: { aliveFrom: 0, aliveTo: 600, samples: 1, gapSeconds: 0, completeness: 2, gapSegments: [] },
        }),
      ]),
    );
    const e = map.get("Alpha");
    expect(e?.wholeGame).toBe(1);
    expect(e?.wholeMove).toBe(0);
    expect(e?.coverage).toBe(1);
  });

  it("resolves a same-nick collision to the recorder, else the better-covered hull", () => {
    const dup = (eid: number, over: Partial<StaticRosterEntry>) =>
      rosterEntry({ entityId: eid, playerName: "Twin", ...over });
    const withRecorder = aiScoreMapOf(
      report([
        dup(1, { coverage: { aliveFrom: 0, aliveTo: 600, samples: 10, gapSeconds: 300, completeness: 0.5, gapSegments: [] } }),
        dup(2, { isRecorder: true }),
      ]),
    );
    expect(withRecorder.get("Twin")?.isRecorder).toBe(true);
    const byCoverage = aiScoreMapOf(report([dup(1, { coverage: { aliveFrom: 0, aliveTo: 600, samples: 10, gapSeconds: 360, completeness: 0.4, gapSegments: [] } }), dup(2, { coverage: { aliveFrom: 0, aliveTo: 600, samples: 10, gapSeconds: 60, completeness: 0.9, gapSegments: [] } })]));
    expect(byCoverage.get("Twin")?.coverage).toBe(0.9);
  });
});

describe("aiRecorderEntryOf", () => {
  it("returns the recorder's scoreable verdict and null when it has none", () => {
    expect(aiRecorderEntryOf(report([rosterEntry({ isRecorder: true })]))?.wholeGame).toBe(0.7);
    expect(
      aiRecorderEntryOf(report([rosterEntry({ isRecorder: true, whole: null })])),
    ).toBeNull();
  });
});

describe("fire applicability", () => {
  it("skips roster rows whose class the fire model does not cover", () => {
    const map = aiScoreMapOf(
      report([
        rosterEntry({ entityId: 1, playerName: "Alpha" }),
        rosterEntry({
          entityId: 2,
          playerName: "Carrier",
          shipClass: "AirCarrier",
          fireApplicable: false,
        }),
        rosterEntry({
          entityId: 3,
          playerName: "Sub",
          shipClass: "Submarine",
          fireApplicable: false,
        }),
      ]),
    );
    expect(map.has("Alpha")).toBe(true);
    // The fire-label space holds zero positive examples for these classes:
    // a movement-only score never enters the AI ranking.
    expect(map.has("Carrier")).toBe(false);
    expect(map.has("Sub")).toBe(false);
    expect(map.size).toBe(1);
    // No entry -> the weighted key falls back to the star share alone.
    expect(aiWeightedKey(map.get("Carrier"), 3000, 12000)).toBeCloseTo(0.25);
  });

  it("omits an unsupported recorder from the share banner verdict", () => {
    expect(
      aiRecorderEntryOf(
        report([
          rosterEntry({
            isRecorder: true,
            shipClass: "Submarine",
            fireApplicable: false,
          }),
        ]),
      ),
    ).toBeNull();
    // A covered recorder still yields its verdict.
    expect(
      aiRecorderEntryOf(report([rosterEntry({ isRecorder: true })]))?.wholeGame,
    ).toBe(0.7);
  });
});

describe("aiWeightedKey — the user's weighting rule", () => {
  it("100% coverage is pure AI", () => {
    expect(aiWeightedKey(entry({ coverage: 1, wholeGame: 0.7 }), 3000, 12000)).toBeCloseTo(0.7);
  });

  it("0% coverage is pure star share", () => {
    expect(aiWeightedKey(entry({ coverage: 0, wholeGame: 0.9 }), 3000, 12000)).toBeCloseTo(0.25);
  });

  it("blends linearly at 90% / 25%", () => {
    // 90% AI + 10% star share.
    expect(aiWeightedKey(entry({ coverage: 0.9, wholeGame: 0.8 }), 1200, 12000)).toBeCloseTo(
      0.9 * 0.8 + 0.1 * 0.1,
    );
    // 25% AI + 75% star share.
    expect(aiWeightedKey(entry({ coverage: 0.25, wholeGame: 0.8 }), 3000, 12000)).toBeCloseTo(
      0.25 * 0.8 + 0.75 * 0.25,
    );
  });

  it("a missing entry degrades to the star share alone", () => {
    expect(aiWeightedKey(undefined, 3000, 12000)).toBeCloseTo(0.25);
    expect(aiWeightedKey(undefined, 0, 12000)).toBe(0);
  });

  it("a zero-XP team drops the star term instead of dividing by zero", () => {
    expect(Number.isFinite(aiWeightedKey(entry({ coverage: 0.5 }), 0, 0))).toBe(true);
    expect(aiWeightedKey(entry({ coverage: 0.5, wholeGame: 0.6 }), 0, 0)).toBeCloseTo(0.3);
  });

  it("orders the 90%-covered ace above a hidden ship with a bigger star share", () => {
    const ace = aiWeightedKey(entry({ coverage: 0.9, wholeGame: 0.85 }), 1000, 12000);
    const dark = aiWeightedKey(entry({ coverage: 0.1, wholeGame: 0.95 }), 3000, 12000);
    expect(ace).toBeGreaterThan(dark);
  });
});

describe("formatAiPct", () => {
  it("renders whole-game agreement as a rounded percentage", () => {
    expect(formatAiPct(0.6234)).toBe("62%");
    expect(formatAiPct(1)).toBe("100%");
    expect(formatAiPct(Number.NaN)).toBe("0%");
  });
});
