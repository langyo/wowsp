/**
 * Plan-board (keyframe) layer over the shared tactical document.
 *
 * A plan board has no replay behind it: the author builds the battle by hand,
 * scrubbing a fixed-length timeline and dropping unit actions on the map. This
 * module turns that document into the derived views the board needs — per-action
 * legs (what the renderer and hit-tester need to place a hull between two
 * marks), tween targets, takeover seconds, and per-unit tracks (what the
 * timeline draws as accordion rows with AE/Flash-style tween arrows).
 *
 * Pure and DOM-free: same contract as model.ts, so unit tests drive it
 * directly. Grouping rule — a "unit" is a marker's variant plus its (trimmed,
 * case-folded) label; an unlabelled marker therefore forms the unit `ship|`
 * together with every other unlabelled ship marker, which is what makes
 * "drop the hull twice and it sails between the two spots" work with no
 * extra bookkeeping.
 */
import type { MarkerElement, TacticalActionKind, TacticalElement, Vec2 } from "./types";

/** Action kinds that carry a unit between two marks. */
const INTERPOLATED: ReadonlySet<TacticalActionKind> = new Set(["move"]);

export function isInterpolatedKind(kind: TacticalActionKind | undefined): boolean {
  return kind != null && INTERPOLATED.has(kind);
}

/** Every plan action kind, in toolbar order. */
export const ACTION_KINDS: readonly TacticalActionKind[] = ["move", "attack", "spot"];

/** A marker that participates in the plan timeline (has an action kind). */
export function isPlanAction(el: TacticalElement): el is MarkerElement {
  return el.kind === "marker" && el.action != null;
}

/** Unit a marker belongs to: same variant + same (normalized) label. */
export function unitKeyOf(el: MarkerElement): string {
  return `${el.variant}|${el.label.trim().toLowerCase()}`;
}

/** Where a leg carries an action's hull, and when it gets there. */
export interface PlanTweenTarget {
  /** Position the unit arrives at. */
  at: Vec2;
  /** Arrival second (the next action's t0). */
  t: number;
  /** Id of the action it arrives at (selection/debug visibility). */
  id: string;
}

/** Walk a unit's actions in time order, mapping each to the one after it.
 *  Ties keep document order (stable sort), so an author who drops two actions
 *  on the same second still gets a deterministic chain. */
function chainActions(actions: MarkerElement[]): { el: MarkerElement; next: MarkerElement }[] {
  const sorted = [...actions].sort((a, b) => a.t0 - b.t0);
  const out: { el: MarkerElement; next: MarkerElement }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    out.push({ el: sorted[i], next: sorted[i + 1] });
  }
  return out;
}

/** Consecutive action pairs of every unit — the raw material of both the legs
 *  and the keyframe takeover below. */
function unitChains(elements: TacticalElement[]): Map<string, MarkerElement[]> {
  const units = new Map<string, MarkerElement[]>();
  for (const el of elements) {
    if (!isPlanAction(el)) continue;
    const key = unitKeyOf(el);
    const list = units.get(key);
    if (list) list.push(el);
    else units.set(key, [el]);
  }
  return units;
}

/** A pair of consecutive actions of one unit is a LEG — an interpolated
 *  segment the hull actually travels — when either end is a `move`. A move is
 *  a travel instruction in both directions: it pulls the unit from the mark
 *  before it and carries it to the mark after it, so `move → attack` still
 *  arrives exactly on the attack's second, and `attack → move` starts moving
 *  the moment the attack lands instead of teleporting the hull. Two
 *  instantaneous events (`attack → spot`) invent no motion between them. */
function hasLeg(a: MarkerElement, b: MarkerElement): boolean {
  if (b.t0 <= a.t0) return false;
  // A hand-drawn route owns its own motion (the explicit path wins).
  if (a.route != null && a.route.length >= 2) return false;
  return isInterpolatedKind(a.action) || isInterpolatedKind(b.action);
}

/** Is this action scripted onto a hand-drawn route? Such an action travels
 *  its own path (render.ts), not a leg toward the next mark. */
function isScripted(el: MarkerElement): boolean {
  return el.route != null && el.route.length >= 2 && !!el.moveDur && el.moveDur > 0;
}

/** Tween target per action id: where a leg carries this action's hull, and
 *  when it gets there. Actions with no leg hold their own position. */
export function planTweenTargets(elements: TacticalElement[]): Map<string, PlanTweenTarget> {
  const out = new Map<string, PlanTweenTarget>();
  for (const unit of unitChains(elements).values()) {
    for (const { el, next } of chainActions(unit)) {
      if (!hasLeg(el, next)) continue;
      out.set(el.id, { at: next.at, t: next.t0, id: next.id });
    }
  }
  return out;
}

/** The second at which a later action of the same unit takes over from this
 *  one — a keyframe the hull has already left must not paint a second hull
 *  (one unit = one hull at any time; its successor draws it). A scripted
 *  action instead hands over when its ROUTE finishes sailing, and only the
 *  last action of a unit is never superseded, so it holds the map for good. */
export function planNextActionT(elements: TacticalElement[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const unit of unitChains(elements).values()) {
    for (const { el, next } of chainActions(unit)) {
      if (isScripted(el)) {
        // The route, not the successor's clock, ends this hull's travel.
        const end = el.t0 + (el.moveDur ?? 0);
        if (end > el.t0) out.set(el.id, end);
        continue;
      }
      // A same-second successor (the author dropped two actions on one mark)
      // must not blank the first hull before it is ever drawn.
      if (next.t0 <= el.t0) continue;
      out.set(el.id, next.t0);
    }
  }
  return out;
}

/** One keyframe as the timeline draws it. */
export interface PlanTrackAction {
  id: string;
  t: number;
  kind: TacticalActionKind;
  /** Arrival second of the tween this action starts (absent = no leg starts
   *  here), so the timeline can span the arrow without re-deriving groups. */
  tweenEndT?: number;
  /** When the unit's NEXT action takes over (absent on the last action):
   *  with no leg in front of it, this is the dotted "no interpolation"
   *  connector the timeline draws instead of an arrow. */
  nextT?: number;
}

/** One accordion row of the plan timeline: a unit and its actions. */
export interface PlanTrack {
  /** Grouping key (variant + normalized label) — stable render `key`. */
  key: string;
  /** Raw label as authored ("" = unlabelled unit, named at display time). */
  label: string;
  variant: MarkerElement["variant"];
  color: string;
  /** Marker ids of the whole chain — the unit's identity spans every
   *  keyframe, so e.g. a rename rewrites them all. */
  ids: string[];
  /** Actions sorted by time. */
  actions: PlanTrackAction[];
}

/** Timeline view model: one track per unit, ordered by each unit's first
 *  action (ties broken by key) so rows never reshuffle while editing. */
export function planTracks(elements: TacticalElement[]): PlanTrack[] {
  const tweens = planTweenTargets(elements);
  const nexts = planNextActionT(elements);
  const tracks: PlanTrack[] = [];
  for (const [key, actions] of unitChains(elements)) {
    const sorted = [...actions].sort((a, b) => a.t0 - b.t0);
    tracks.push({
      key,
      label: sorted[0].label,
      variant: sorted[0].variant,
      color: sorted[0].color,
      ids: sorted.map((el) => el.id),
      actions: sorted.map((el) => {
        const end = tweens.get(el.id);
        const next = nexts.get(el.id);
        return {
          id: el.id,
          t: el.t0,
          kind: el.action ?? "move",
          ...(end ? { tweenEndT: end.t } : {}),
          // A scripted action travels its own route — no "jump" connector.
          ...(next != null && !isScripted(el) ? { nextT: next } : {}),
        };
      }),
    });
  }
  tracks.sort((a, b) => {
    const at = a.actions[0]?.t ?? 0;
    const bt = b.actions[0]?.t ?? 0;
    return at !== bt ? at - bt : a.key.localeCompare(b.key);
  });
  return tracks;
}
