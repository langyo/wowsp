/** Plan-board logic tests: unit grouping, tween targets and the timeline
 *  track view model (pure, no DOM). */
import { describe, expect, it } from "vitest";
import type { MarkerElement, TacticalActionKind, TacticalElement } from "./types";
import { commitMarker, commitRouteMarker, commitShape, commitText } from "./model";
import {
  isInterpolatedKind,
  isPlanAction,
  planNextActionT,
  planTracks,
  planTweenTargets,
  unitKeyOf,
} from "./plan";

const p = (x: number, z: number) => ({ x, z });
const look = { color: "#ff0000", width: 4, dash: "solid" as const };

/** One plan keyframe of a (default: unlabelled ship) unit. */
const frame = (
  t: number,
  at: { x: number; z: number },
  action: TacticalActionKind,
  label = "",
  color = "#ff8800",
): MarkerElement => commitMarker(at, 0, "ship", color, t, label, action);

describe("unitKeyOf", () => {
  it("groups a variant's markers by trimmed, case-folded label", () => {
    const a = frame(0, p(0, 0), "move", "  Yamato ");
    const b = frame(30, p(50, 0), "attack", "yamato");
    expect(unitKeyOf(a)).toBe(unitKeyOf(b));
  });

  it("keeps variants and labels apart", () => {
    expect(unitKeyOf(frame(0, p(0, 0), "move", "Yamato"))).not.toBe(
      unitKeyOf(frame(0, p(0, 0), "move", "Musashi")),
    );
    expect(unitKeyOf(commitMarker(p(0, 0), 0, "plane", "#fff", 0, "Yamato"))).not.toBe(
      unitKeyOf(frame(0, p(0, 0), "move", "Yamato")),
    );
  });

  it("folds every unlabelled marker of a variant into one unit", () => {
    expect(unitKeyOf(frame(0, p(0, 0), "move"))).toBe(unitKeyOf(frame(9, p(3, 3), "spot", "   ")));
  });
});

describe("isPlanAction / isInterpolatedKind", () => {
  it("accepts markers carrying an action kind only", () => {
    expect(isPlanAction(frame(0, p(0, 0), "move"))).toBe(true);
    expect(isPlanAction(commitMarker(p(0, 0), 0, "ship", "#fff", 0, "Yamato"))).toBe(false);
    expect(isPlanAction(commitText(p(0, 0), "push B", "#fff", 0))).toBe(false);
    expect(isPlanAction(commitShape("arrow", p(0, 0), p(1, 1), look, 0))).toBe(false);
  });

  it("interpolates `move` only", () => {
    expect(isInterpolatedKind("move")).toBe(true);
    expect(isInterpolatedKind("attack")).toBe(false);
    expect(isInterpolatedKind("spot")).toBe(false);
    expect(isInterpolatedKind(undefined)).toBe(false);
  });
});

describe("planTweenTargets", () => {
  it("points a move at the unit's next action of any kind", () => {
    const move = frame(10, p(0, 0), "move");
    const strike = frame(30, p(300, 0), "attack");
    expect(planTweenTargets([move, strike])).toEqual(
      new Map([[move.id, { at: p(300, 0), t: 30, id: strike.id }]]),
    );
  });

  it("leaves the last action of a unit without a target", () => {
    const only = frame(10, p(0, 0), "move");
    expect(planTweenTargets([only]).size).toBe(0);
    // Nothing follows the move, so nothing can pull it anywhere.
    const tail = frame(20, p(10, 10), "move");
    expect(planTweenTargets([frame(5, p(0, 0), "attack"), tail]).has(tail.id)).toBe(false);
  });

  it("tweens both legs of move → attack → move", () => {
    const move = frame(0, p(0, 0), "move");
    const strike = frame(10, p(0, 100), "attack");
    const back = frame(20, p(0, 0), "move");
    expect(planTweenTargets([move, strike, back])).toEqual(
      new Map([
        [move.id, { at: p(0, 100), t: 10, id: strike.id }],
        [strike.id, { at: p(0, 0), t: 20, id: back.id }],
      ]),
    );
  });

  it("moves a unit into and out of an attack, but invents no motion between two events", () => {
    const strike = frame(0, p(0, 0), "attack");
    // attack → move: the move pulls the hull off the attack mark.
    const leave = frame(10, p(50, 0), "move");
    expect(planTweenTargets([strike, leave]).get(strike.id)).toEqual({
      at: p(50, 0),
      t: 10,
      id: leave.id,
    });
    // attack → spot: two instantaneous events, nothing travels between them.
    expect(planTweenTargets([strike, frame(30, p(90, 0), "spot")]).size).toBe(0);
  });

  it("never chains actions across units", () => {
    const alpha = frame(0, p(0, 0), "move", "Alpha");
    const bravo = frame(10, p(500, 0), "attack", "Bravo");
    expect(planTweenTargets([alpha, bravo]).size).toBe(0);
  });

  it("skips an element whose motion a scripted route owns", () => {
    const route = commitRouteMarker([p(0, 0), p(50, 0)], "#c00", 0, 0.5, 10)!;
    const routed: MarkerElement = { ...route, label: "Alpha", action: "move" };
    const routedNext = frame(40, p(90, 90), "attack", "Alpha");
    // Same shape, no route → the tween target exists, so the skip is the route.
    const plain = frame(0, p(0, 0), "move", "Bravo");
    const plainNext = frame(40, p(90, 90), "attack", "Bravo");
    const targets = planTweenTargets([routed, routedNext, plain, plainNext]);
    expect(targets.has(routed.id)).toBe(false);
    expect(targets.get(plain.id)).toEqual({ at: p(90, 90), t: 40, id: plainNext.id });
  });

  it("never targets an action that does not move the unit forward in time", () => {
    const move = frame(10, p(0, 0), "move");
    const sameSecond = frame(10, p(90, 0), "attack");
    expect(planTweenTargets([move, sameSecond]).size).toBe(0);
  });

  it("keeps only plan actions out of a mixed document", () => {
    const move = frame(0, p(0, 0), "move", "Alpha");
    const next = frame(10, p(0, 100), "spot", "Alpha");
    const noise: TacticalElement[] = [
      commitShape("arrow", p(0, 0), p(1, 1), look, 0),
      commitText(p(0, 0), "note", "#fff", 0),
      commitMarker(p(9, 9), 0, "ship", "#fff", 0, "Alpha"),
    ];
    expect(planTweenTargets([...noise, move, next]).get(move.id)).toEqual({
      at: p(0, 100),
      t: 10,
      id: next.id,
    });
  });
});

describe("planNextActionT", () => {
  it("reports the takeover second of every action but the last", () => {
    const strike = frame(0, p(0, 0), "attack", "Alpha");
    const move = frame(10, p(0, 100), "move", "Alpha");
    const tail = frame(25, p(0, 200), "spot", "Alpha");
    expect(planNextActionT([strike, move, tail])).toEqual(
      new Map([
        [strike.id, 10],
        [move.id, 25],
      ]),
    );
  });

  it("gives a takeover second even where no leg exists", () => {
    const strike = frame(0, p(0, 0), "attack", "Alpha");
    const look = frame(15, p(50, 0), "spot", "Alpha");
    expect(planNextActionT([strike, look]).get(strike.id)).toBe(15);
  });

  it("does not supersede an action a same-second successor shares the mark with", () => {
    const first = frame(10, p(0, 0), "attack", "Alpha");
    const second = frame(10, p(0, 0), "spot", "Alpha");
    expect(planNextActionT([first, second]).size).toBe(0);
  });

  it("hands a scripted action over when its route finishes sailing, not at the successor", () => {
    const routed: MarkerElement = {
      ...commitRouteMarker([p(0, 0), p(50, 0)], "#c00", 0, 0.5, 10)!,
      label: "Charlie",
      action: "move",
    };
    const after = frame(40, p(90, 0), "move", "Charlie");
    expect(planNextActionT([routed, after]).get(routed.id)).toBe(10);
    // The timeline shows no "jump" connector for a travelling route.
    const [track] = planTracks([routed, after]);
    expect(track.actions[0]).toEqual({ id: routed.id, t: 0, kind: "move" });
  });

  it("only chains within a unit", () => {
    const alpha = frame(0, p(0, 0), "move", "Alpha");
    const bravo = frame(5, p(0, 0), "move", "Bravo");
    expect(planNextActionT([alpha, bravo]).size).toBe(0);
  });
});

describe("planTracks", () => {
  it("builds one track per unit, with that unit's actions in time order", () => {
    const tracks = planTracks([
      frame(30, p(50, 0), "attack", "Yamato"),
      frame(10, p(0, 0), "move", "Yamato"),
      frame(0, p(0, 0), "spot", "Musashi"),
      // Non-plan elements never form a track of their own.
      commitMarker(p(0, 0), 0, "ship", "#fff", 0, "Yamato"),
      commitText(p(0, 0), "note", "#fff", 0),
      commitShape("arrow", p(0, 0), p(1, 1), look, 0),
    ]);
    expect(tracks.map((t) => t.key)).toEqual(["ship|musashi", "ship|yamato"]);
    expect(tracks[1].actions.map((a) => a.t)).toEqual([10, 30]);
    expect(planTracks([])).toEqual([]);
  });

  it("reports the unit's label, variant and colour", () => {
    const [track] = planTracks([frame(5, p(0, 0), "move", "Yamato", "#ff00ff")]);
    expect(track).toMatchObject({
      key: "ship|yamato",
      label: "Yamato",
      variant: "ship",
      color: "#ff00ff",
    });
  });

  it("reports each action's leg end and its successor's takeover second", () => {
    const move = frame(0, p(0, 0), "move", "Alpha");
    const strike = frame(20, p(100, 0), "attack", "Alpha");
    const tail = frame(40, p(200, 0), "move", "Alpha");
    const [track] = planTracks([tail, strike, move]);
    expect(track.actions).toEqual([
      { id: move.id, t: 0, kind: "move", tweenEndT: 20, nextT: 20 },
      { id: strike.id, t: 20, kind: "attack", tweenEndT: 40, nextT: 40 },
      { id: tail.id, t: 40, kind: "move" },
    ]);
  });

  it("carries the takeover second even with no leg in front of it", () => {
    const strike = frame(0, p(0, 0), "attack", "Alpha");
    const look = frame(15, p(50, 0), "spot", "Alpha");
    const [track] = planTracks([strike, look]);
    expect(track.actions).toEqual([
      { id: strike.id, t: 0, kind: "attack", nextT: 15 },
      { id: look.id, t: 15, kind: "spot" },
    ]);
  });

  it("orders tracks by their first action, ties by key", () => {
    expect(
      planTracks([
        frame(30, p(0, 0), "attack", "Zulu"),
        frame(30, p(0, 0), "attack", "Alpha"),
        frame(10, p(0, 0), "spot", "Bravo"),
      ]).map((t) => t.key),
    ).toEqual(["ship|bravo", "ship|alpha", "ship|zulu"]);
  });
});
