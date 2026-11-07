/**
 * ReportTimeline tests — the editor timeline's pure geometry (time mapping,
 * ruler, keyframe hit-testing, callout lane packing) and its interaction
 * contract: keyframes open the situation card on hover/focus, clicking one
 * jumps straight to its moment (no pinned card, no in-card button), the axis
 * reports the position under the cursor, and capture mode swaps all of that
 * for the static annotation band.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import ReportTimeline, {
  assignCalloutLanes,
  inCoverageGap,
  markerHitIndex,
  nearestMomentIndex,
  nearestSampleIndex,
  rulerTicks,
  timelineFrac,
} from "./ReportTimeline";
import type { StaticMoment, StaticReport } from "@/api";

enableAutoUnmount(afterEach);

function moment(overrides: Partial<StaticMoment> = {}): StaticMoment {
  return {
    t: 100,
    category: "damageRealized",
    weight: 1,
    hpFrac: 1,
    speedKt: 18,
    enemiesObserved: 2,
    nearestEnemy: { entityId: 9, distM: 3800, bearingRelRad: 0.2, inRange: true },
    fired: true,
    fireProb: 0.08,
    moveSector: 14,
    advisedSector: 16,
    advisedProb: 0.4,
    inst: 0.08,
    fireAlignment: 0.1,
    moveAlignment: 0.2,
    confidence: 0.62,
    hpLostWindow: 9400,
    hpFracAfter: 0.94,
    ...overrides,
  };
}

function report(overrides: Partial<StaticReport> = {}): StaticReport {
  return {
    replayPath: "replays/r.wowsreplay",
    replayId: "r",
    mapName: "spaces/15_NE_north",
    gameMode: "Domination",
    durationS: 600,
    losLoaded: false,
    modelSources: { fire: "models/fire.onnx", moveModel: "models/move.onnx" },
    entityId: 1,
    roster: [
      {
        entityId: 1,
        shipId: 1,
        shipClass: "Destroyer",
        fireApplicable: true,
        name: "me",
        playerName: "me",
        teamId: 0,
        isRecorder: true,
        diedAt: null,
        coverage: {
          aliveFrom: 0,
          aliveTo: 600,
          samples: 40,
          gapSeconds: 19,
          completeness: 0.97,
          gapSegments: [[200, 219]],
        },
        whole: {
          wholeGame: 0.59,
          wholeFire: 0.83,
          wholeMove: 0.42,
          contribution: 59500,
          contributionShots: 11,
        },
        outcome: null,
      },
    ],
    timeline: [
      { t: 0, inst: 0.5, confidence: 0.5, fire: 0.4, fired: false, fireProb: 0.6, hpLost: null, move: 0.55 },
      { t: 100, inst: 0.08, confidence: 0.62, fire: 0.6, fired: true, fireProb: null, hpLost: 800, move: 0.2 },
      { t: 300, inst: 0.3, confidence: 0.7, fire: null, fired: null, fireProb: null, hpLost: null, move: 0.4 },
      { t: 600, inst: 0.2, confidence: 0.6, fire: 0.3, fired: false, fireProb: 0.7, hpLost: null, move: 0.25 },
    ],
    moments: [
      moment({ t: 100 }),
      moment({ t: 250, category: "forcedShot", fired: false }),
      moment({ t: 500, category: "strongWindow", hpLostWindow: null }),
    ],
    ...overrides,
  };
}

function mountTimeline(options: {
  capturing?: boolean;
  onSeek?: (t: number) => void;
  data?: StaticReport;
} = {}) {
  return mount(ReportTimeline, {
    props: {
      report: options.data ?? report(),
      capturing: options.capturing ?? false,
      onSeek: options.onSeek,
    },
  });
}

/** Absolute (x, y) pairs of an SVG path's "M/L x y" command list. */
function trackPoints(d: string | undefined): { x: number; y: number }[] {
  const numbers = (d ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i], y: numbers[i + 1] });
  }
  return points;
}

describe("timeline geometry", () => {
  it("maps battle seconds onto the shared window", () => {
    // window = [-(HEADROOM), duration]; the first sample sits inside the plot.
    expect(timelineFrac(0, 600)).toBeCloseTo((2 / 602) * 100, 6);
    expect(timelineFrac(300, 600)).toBeCloseTo((302 / 602) * 100, 6);
    expect(timelineFrac(600, 600)).toBeCloseTo(100, 6);
    // Degenerate durations still map finitely.
    expect(Number.isFinite(timelineFrac(0, 0))).toBe(true);
  });

  it("picks round ruler steps and always pins the horizon", () => {
    expect(rulerTicks(60)).toEqual([
      { t: 0, label: "00:00" },
      { t: 15, label: "00:15" },
      { t: 30, label: "00:30" },
      { t: 45, label: "00:45" },
      { t: 60, label: "01:00" },
    ]);
    const long = rulerTicks(1053);
    expect(long.map((tick) => tick.label)).toEqual([
      "00:00",
      "05:00",
      "10:00",
      "15:00",
      "17:33",
    ]);
  });

  it("finds the nearest sample / moment / coverage gap", () => {
    const samples = [{ t: 0 }, { t: 100 }, { t: 300 }, { t: 600 }];
    expect(nearestSampleIndex(samples, 90)).toBe(1);
    expect(nearestSampleIndex(samples, 460)).toBe(3);
    expect(nearestSampleIndex([], 10)).toBeNull();

    const moments = [{ t: 60 }, { t: 240 }, { t: 580 }];
    expect(nearestMomentIndex(moments, 230)).toBe(1);
    expect(nearestMomentIndex([], 10)).toBeNull();

    const gaps: [number, number][] = [[200, 219]];
    expect(inCoverageGap(gaps, 210)).toBe(true);
    expect(inCoverageGap(gaps, 199)).toBe(false);
    expect(inCoverageGap([], 210)).toBe(false);
  });

  it("hit-tests keyframes within the pointer slop", () => {
    const moments = [{ t: 100 }, { t: 300 }];
    // 1000 px plot: 100s sits at (102/602)*1000 ≈ 169 px, 300s at ≈ 502 px.
    expect(markerHitIndex(17, 600, moments, 1000)).toBe(0);
    expect(markerHitIndex(50.2, 600, moments, 1000)).toBe(1);
    expect(markerHitIndex(40, 600, moments, 1000)).toBeNull();
    // An off-plot pointer clamps to the edge before testing, never indexes
    // past the plot.
    expect(markerHitIndex(-20, 600, moments, 1000)).toBeNull();
  });

  it("packs callouts into non-overlapping lanes and clamps edges", () => {
    const placed = assignCalloutLanes([60, 300, 540, 780, 960], 1000, 250);
    expect(placed.map((entry) => entry.lane)).toEqual([0, 1, 0, 1, 0]);
    // Every lane's cards are ordered and clear of each other.
    for (const lane of [0, 1]) {
      const row = placed.filter((entry) => entry.lane === lane);
      for (let i = 1; i < row.length; i += 1) {
        expect(row[i].left).toBeGreaterThanOrEqual(row[i - 1].left + 250 + 8);
      }
    }
    // Edge cards never leave the plot; the leader still lands inside them.
    const edges = assignCalloutLanes([2, 998], 1000, 250);
    expect(edges[0].left).toBe(0);
    expect(edges[1].left).toBe(750);
  });
});

describe("ReportTimeline interaction", () => {
  it("renders one keyframe per moment, plus the ruler and the score track", () => {
    const w = mountTimeline();
    expect(w.findAll(".srp-tl__kf")).toHaveLength(3);
    expect(w.find(".srp-tl__ruler").exists()).toBe(true);
    expect(w.find(".srp-tl__track svg").exists()).toBe(true);
    // Interactive surfaces do not render the static annotation band.
    expect(w.find(".srp-tl__callouts").exists()).toBe(false);
    expect(w.find(".srp-tl__hint").exists()).toBe(true);
  });

  it("floats the situation card on focus with no in-card action", async () => {
    const w = mountTimeline();
    const marker = w.findAll(".srp-tl__kf")[0];
    await marker.trigger("focus");
    await nextTick();
    expect(w.find(".srp-tl__tip").exists()).toBe(true);
    expect(w.find(".srp-tl__tip").text()).toContain("#1");
    expect(w.find(".srp-tl__tip").text()).toContain("01:40");
    // Read-only card: the old Jump/Close buttons vanished while the pointer
    // travelled to them (2026-11-07 report); the jump lives on the keyframe
    // button itself now.
    expect(w.find(".srp-tl__tip button").exists()).toBe(false);
    await marker.trigger("blur");
    await nextTick();
    expect(w.find(".srp-tl__tip").exists()).toBe(false);
  });

  it("jumps straight from a clicked keyframe — no pinned step", async () => {
    const onSeek = vi.fn();
    const w = mountTimeline({ onSeek });
    await w.findAll(".srp-tl__kf")[1].trigger("click");
    expect(onSeek).toHaveBeenCalledWith(250);
    // A click is the jump, not a pin: no card stays on screen (the host
    // closes the whole report window and lands the replay).
    expect(w.find(".srp-tl__tip").exists()).toBe(false);
    expect(w.find(".srp-tl__tip-actions").exists()).toBe(false);
  });

  it("jumps from the keyboard-activated keyframe too", async () => {
    const onSeek = vi.fn();
    const w = mountTimeline({ onSeek });
    const marker = w.findAll(".srp-tl__kf")[2];
    await marker.trigger("focus");
    await marker.trigger("click");
    expect(onSeek).toHaveBeenCalledWith(500);
  });

  it("reports the position under the cursor", async () => {
    const w = mountTimeline();
    const lane = w.find(".srp-tl__lane").element as HTMLElement;
    lane.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 1000,
        height: 40,
        right: 1000,
        bottom: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    // 70% of the window: battle t = 0.7 * 602 - 2 = 419.4 s → "06:59";
    // the nearest score sample is 300 s (inst 0.3 → 30%).
    await w.find(".srp-tl__lane").trigger("pointermove", { clientX: 700 });
    await nextTick();
    const readout = w.find(".srp-tl__readout");
    expect(readout.exists()).toBe(true);
    expect(readout.text()).toContain("06:59");
    expect(readout.text()).toContain("30%");
    expect(readout.text()).toContain("#3");
  });

  it("draws both evaluation models as edge-to-edge envelopes", () => {
    const w = mountTimeline();
    const move = w.find(".srp-tl__score-line--move");
    const fire = w.find(".srp-tl__score-line--fire");
    expect(move.exists()).toBe(true);
    expect(fire.exists()).toBe(true);
    // The move model is scored on every row: the path reaches the track's
    // right edge (viewBox width) at the data horizon.
    const movePoints = trackPoints(move.attributes("d"));
    expect(movePoints.length).toBe(4);
    expect(movePoints[movePoints.length - 1].x).toBeCloseTo(1000, 0);
    // The fire model only exists on can-fire rows: its dashed envelope
    // bridges the unscored rows (one path), and only ISOLATED scored rows
    // get a dot (the run 0/100 s can draw a segment; 600 s cannot).
    const fireD = fire.attributes("d") ?? "";
    expect((fireD.match(/M/g) ?? []).length).toBe(1);
    expect((fireD.match(/L/g) ?? []).length).toBe(2);
    expect(w.findAll(".srp-tl__score-dot")).toHaveLength(1);
    const legend = w.find(".srp-tl__track-legend").text();
    expect(legend).toContain("replay.report.moveModel");
    expect(legend).toContain("replay.report.fireModel");
  });

  it("ends the axis at a sunk player's data horizon", () => {
    const base = report();
    const died = report({
      durationS: 600,
      roster: [
        {
          ...base.roster[0],
          coverage: {
            ...base.roster[0].coverage,
            aliveTo: 300,
            completeness: 1,
            gapSegments: [],
          },
        },
      ],
      timeline: [
        { t: 0, inst: 0.5, confidence: 0.5, fire: 0.4, fired: false, fireProb: 0.6, hpLost: null, move: 0.55 },
        { t: 300, inst: 0.2, confidence: 0.6, fire: 0.3, fired: false, fireProb: 0.7, hpLost: null, move: 0.25 },
      ],
      moments: [moment({ t: 100 }), moment({ t: 250 })],
    });
    const w = mountTimeline({ data: died });
    const ruler = w.find(".srp-tl__ruler").text();
    expect(ruler).toContain("05:00");
    expect(ruler).not.toContain("10:00");
    // The final sample lands on the right edge — no dead tail.
    const points = trackPoints(
      w.find(".srp-tl__score-line--move").attributes("d"),
    );
    expect(points[points.length - 1].x).toBeCloseTo(1000, 0);
  });

  it("inks every keyframe with its category tone", () => {
    const w = mountTimeline();
    const tones = w
      .findAll(".srp-tl__kf-glyph")
      .map((glyph) => glyph.classes().find((c) => c.startsWith("srp-tl__kf-glyph--")));
    expect(tones).toEqual([
      "srp-tl__kf-glyph--good",
      "srp-tl__kf-glyph--warn",
      "srp-tl__kf-glyph--ok",
    ]);
  });

  it("drops the hover card when capture mode starts", async () => {
    const w = mountTimeline();
    await w.findAll(".srp-tl__kf")[0].trigger("focus");
    await nextTick();
    expect(w.find(".srp-tl__tip").exists()).toBe(true);
    // Keyboard focus fires no pointerleave, so capture entry itself must
    // clear the interaction surface.
    await w.setProps({ capturing: true });
    await nextTick();
    expect(w.find(".srp-tl__tip").exists()).toBe(false);
    expect(w.findAll(".srp-tl__callout")).toHaveLength(3);
  });

  it("falls back to the last scored row when the coverage horizon is unusable", () => {
    const base = report();
    const censored = report({
      timeline: [
        { t: 0, inst: 0.5, confidence: 0.5, fire: 0.4, fired: false, fireProb: 0.6, hpLost: null, move: 0.55 },
        { t: 250, inst: 0.2, confidence: 0.6, fire: 0.3, fired: false, fireProb: 0.7, hpLost: null, move: 0.25 },
      ],
      roster: [
        {
          ...base.roster[0],
          coverage: { ...base.roster[0].coverage, aliveTo: 0, gapSegments: [] },
        },
      ],
      moments: [moment({ t: 100 })],
    });
    const w = mountTimeline({ data: censored });
    const ruler = w.find(".srp-tl__ruler").text();
    expect(ruler).toContain("04:10");
    expect(ruler).not.toContain("10:00");
    const points = trackPoints(
      w.find(".srp-tl__score-line--move").attributes("d"),
    );
    expect(points[points.length - 1].x).toBeCloseTo(1000, 0);
  });

  it("hides the fire key when no row was scored by that model", () => {
    const w = mountTimeline({
      data: report({
        timeline: [
          { t: 0, inst: 0.5, confidence: 0.5, fire: null, fired: null, fireProb: null, hpLost: null, move: 0.55 },
          { t: 600, inst: 0.2, confidence: 0.6, fire: null, fired: null, fireProb: null, hpLost: null, move: 0.25 },
        ],
      }),
    });
    const legend = w.find(".srp-tl__track-legend").text();
    expect(legend).toContain("replay.report.moveModel");
    expect(legend).not.toContain("replay.report.fireModel");
    expect(w.find(".srp-tl__score-line--fire").attributes("d")).toBe("");
    expect(w.findAll(".srp-tl__score-dot")).toHaveLength(0);
  });

  it("drops the fire-decision row when no fire decision existed", async () => {
    const noFire = report({
      timeline: [
        { t: 0, inst: 0.5, confidence: 0.5, fire: null, fired: null, fireProb: null, hpLost: null, move: 0.55 },
        { t: 600, inst: 0.2, confidence: 0.6, fire: null, fired: null, fireProb: null, hpLost: null, move: 0.25 },
      ],
      moments: [moment({ t: 100, fired: null, fireProb: null })],
    });
    const w = mountTimeline({ data: noFire });
    // An all-null fire series is a legitimate report (an uncovered class):
    // the fire envelope stays empty instead of drawing a bogus path.
    expect(w.find(".srp-tl__score-line--fire").attributes("d")).toBe("");
    expect(w.findAll(".srp-tl__score-dot")).toHaveLength(0);
    await w.findAll(".srp-tl__kf")[0].trigger("focus");
    await nextTick();
    const tip = w.find(".srp-tl__tip");
    expect(tip.exists()).toBe(true);
    // No "Fire decision —" row: nothing was on the table.
    expect(tip.text()).not.toContain("replay.report.fireAction");
    // The row returns as soon as the moment carries the fired flag.
    const withFire = mountTimeline();
    await withFire.findAll(".srp-tl__kf")[0].trigger("focus");
    await nextTick();
    expect(withFire.find(".srp-tl__tip").text()).toContain(
      "replay.report.fireAction",
    );
  });

  it("drops the fire-decision row from captured callouts too", async () => {
    const noFire = report({
      moments: [
        moment({ t: 100, fired: null, fireProb: null }),
        moment({ t: 250, category: "forcedShot", fired: false }),
      ],
    });
    const w = mountTimeline({ data: noFire, capturing: true });
    await flushPromises();
    const callouts = w.findAll(".srp-tl__callout");
    expect(callouts).toHaveLength(2);
    expect(callouts[0].text()).not.toContain("replay.report.fireAction");
    expect(callouts[1].text()).toContain("replay.report.fireAction");
  });

  it("marks the move point when the series is a single row", () => {
    const w = mountTimeline({
      data: report({
        timeline: [
          { t: 0, inst: 0.5, confidence: 0.5, fire: null, fired: null, fireProb: null, hpLost: null, move: 0.55 },
        ],
      }),
    });
    const dot = w.find(".srp-tl__score-dot--move");
    expect(dot.exists()).toBe(true);
    expect(dot.attributes("style")).toContain("left: 0.3322");
  });

  it("reports both model values in the axis readout", async () => {
    const w = mountTimeline();
    const lane = w.find(".srp-tl__lane");
    const element = lane.element as HTMLElement;
    (element.getBoundingClientRect as unknown as () => DOMRect) = () =>
      ({ left: 0, top: 0, width: 1000, height: 40, right: 1000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await lane.trigger("pointermove", { clientX: 400, clientY: 20 });
    const readout = w.find(".srp-tl__readout");
    expect(readout.exists()).toBe(true);
    const models = w.findAll(".srp-tl__readout-model");
    expect(models).toHaveLength(2);
    expect(models[0].attributes("aria-label")).toContain(
      "replay.report.moveModel",
    );
    expect(models[1].attributes("aria-label")).toContain(
      "replay.report.fireModel",
    );
  });

  it("labels the score track's y axis with percentages and the read hint", () => {
    const w = mountTimeline();
    const marks = w.findAll(".srp-tl__yaxis-mark");
    expect(marks.map((mark) => mark.text())).toEqual([
      "100%",
      "75%",
      "50%",
      "25%",
      "0%",
    ]);
    expect(w.find(".srp-tl__yaxis-title").text()).toBe(
      "replay.report.modelAxis",
    );
    expect(w.find(".srp-tl__head-note").text()).toBe(
      "replay.report.axisHint",
    );
  });

  it("anchors the axis labels to the percentage grid", () => {
    const w = mountTimeline();
    const plot = w.find(".srp-tl__plot");
    expect(plot.attributes("style")).toContain("padding-left: 54px");
    expect(w.find(".srp-tl__yaxis").attributes("style")).toContain(
      "height: 158px",
    );
    const tops = w.findAll(".srp-tl__yaxis-mark").map((mark) => {
      const match = (mark.attributes("style") ?? "").match(/top: ([\d.]+)px/);
      return match ? match[1] : null;
    });
    // trackY(1/.75/.5/.25/0) at TRACK_HEIGHT=158, pads 8/8.
    expect(tops).toEqual(["8", "43.5", "79", "114.5", "150"]);
  });

  it("clamps a coverage gap that runs past the last scored row", () => {
    const base = report();
    const censored = report({
      timeline: [
        { t: 0, inst: 0.5, confidence: 0.5, fire: 0.4, fired: false, fireProb: 0.6, hpLost: null, move: 0.55 },
        { t: 600, inst: 0.2, confidence: 0.6, fire: 0.3, fired: false, fireProb: 0.7, hpLost: null, move: 0.25 },
      ],
      roster: [
        {
          ...base.roster[0],
          coverage: {
            ...base.roster[0].coverage,
            aliveTo: 900,
            gapSegments: [
              [560, 700],
              [700, 900],
            ],
          },
        },
      ],
      moments: [moment({ t: 100 })],
    });
    const w = mountTimeline({ data: censored });
    // One span per layer (ruler/lane band + track band); the dead tail gap
    // is dropped from both.
    const gaps = w.findAll(".srp-tl__gap");
    expect(gaps).toHaveLength(2);
    const style = gaps[0].attributes("style") ?? "";
    const left = Number(style.match(/left: ([\d.]+)%/)?.[1]);
    const width = Number(style.match(/width: ([\d.]+)%/)?.[1]);
    expect(left).toBeGreaterThan(90);
    expect(left + width).toBeLessThanOrEqual(100.001);
  });

  it("keeps the annotation band below the track inside the plot gutter", async () => {
    const w = mountTimeline({ capturing: true });
    // DOM order: the track opens, the y-axis rides INSIDE it, the track
    // closes, and only then does the annotation band begin.
    const html = w.html();
    const at = (needle: string) => html.indexOf(needle);
    const track = at('class="srp-tl__track"');
    const yaxis = at('class="srp-tl__yaxis"');
    const callouts = at('class="srp-tl__callouts"');
    expect(track).toBeGreaterThan(-1);
    expect(yaxis).toBeGreaterThan(track);
    expect(callouts).toBeGreaterThan(yaxis);
    expect(w.find(".srp-tl__track .srp-tl__yaxis").exists()).toBe(true);
    // The plot keeps its y-axis gutter (the band rides the padded box, not
    // the gutter).
    expect(w.find(".srp-tl__plot").attributes("style")).toContain(
      "padding-left: 54px",
    );
    // Leaders start exactly at the lane centre (20 + 10 + 158 + 10) and the
    // lane-0 leader reaches the band top.
    const leader = w.find(".srp-tl__leader").attributes("style") ?? "";
    expect(leader).toContain("top: -198px");
    expect(leader).toContain("height: 198px");
  });

  it("renders the y axis in the captured image too", async () => {
    const w = mountTimeline({ capturing: true });
    expect(w.findAll(".srp-tl__yaxis-mark")).toHaveLength(5);
    expect(w.find(".srp-tl__yaxis").exists()).toBe(true);
  });

  it("renders the static annotation band in capture mode only", async () => {
    const onSeek = vi.fn();
    const w = mountTimeline({ capturing: true, onSeek });
    await flushPromises();
    expect(w.findAll(".srp-tl__callout")).toHaveLength(3);
    expect(w.findAll(".srp-tl__leader")).toHaveLength(3);
    expect(w.find(".srp-tl__hint").exists()).toBe(false);
    // No interaction surface is mounted into the static frame: a keyframe
    // click cannot seek or float a card while capturing.
    await w.findAll(".srp-tl__kf")[0].trigger("click");
    await nextTick();
    expect(onSeek).not.toHaveBeenCalled();
    expect(w.find(".srp-tl__tip").exists()).toBe(false);
    // The callouts carry the same detail rows the hover card does.
    expect(w.find(".srp-tl__callout").text()).toContain("#1");
    expect(w.find(".srp-tl__callout").text()).toContain("01:40");
  });
});

describe("ReportTimeline empty state", () => {
  it("keeps the ruler and reports the no-moments caption", () => {
    const w = mountTimeline({ data: report({ moments: [] }) });
    expect(w.findAll(".srp-tl__kf")).toHaveLength(0);
    expect(w.find(".srp-tl__empty").text()).toBe("replay.report.noMoments");
    expect(w.find(".srp-tl__ruler").exists()).toBe(true);
  });
});
