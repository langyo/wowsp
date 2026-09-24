/**
 * Plan-board (keyframe) layer over the shared tactical document.
 *
 * A plan board has no replay behind it: the author builds the battle by hand,
 * scrubbing a fixed-length timeline and dropping unit actions on the map. This
 * module turns that document into the two derived views the board needs —
 * per-element tween targets (what the renderer/hit-tester need to place a hull
 * between two actions) and per-unit tracks (what the timeline draws as
 * accordion rows with AE/Flash-style tween arrows).
 *
 * Pure and DOM-free: same contract as model.ts, so unit tests drive it
 * directly. Grouping rule — a "unit" is a marker's variant plus its (trimmed,
 * case-folded) label; an unlabelled marker therefore forms the unit `ship|`
 * together with every other unlabelled ship marker, which is what makes
 * "drop the hull twice and it sails between the two spots" work with no
 * extra bookkeeping.
 */
import type { MarkerElement, TacticalActionKind, TacticalElement, Vec2 } from "./types";

/** Action kinds that interpolate toward the unit's next action. */
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

/** Where a `move` action is headed: the unit's next action. */
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

function groupByUnit(elements: TacticalElement[]): Map<string, MarkerElement[]> {
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

/** Tween target per action id: a `move` action tweens to the unit's next
 *  action of ANY kind (a move followed by an attack must arrive at the attack
 *  spot), and the last action of a unit holds its position. Actions with a
 *  scripted `route` are skipped — the hand-drawn path owns their motion. */
export function planTweenTargets(elements: TacticalElement[]): Map<string, PlanTweenTarget> {
  const out = new Map<string, PlanTweenTarget>();
  for (const unit of groupByUnit(elements).values()) {
    for (const { el, next } of chainActions(unit)) {
      if (!isInterpolatedKind(el.action)) continue;
      if (el.route != null && el.route.length >= 2) continue;
      if (next.t0 <= el.t0) continue;
      out.set(el.id, { at: next.at, t: next.t0, id: next.id });
    }
  }
  return out;
}

/** One keyframe as the timeline draws it. */
export interface PlanTrackAction {
  id: string;
  t: number;
  kind: TacticalActionKind;
  /** Arrival second of the tween this action starts (absent = not a tween
   *  start), so the timeline can span the arrow without re-deriving groups. */
  tweenEndT?: number;
}

/** One accordion row of the plan timeline: a unit and its actions. */
export interface PlanTrack {
  /** Grouping key (variant + normalized label) — stable render `key`. */
  key: string;
  /** Raw label as authored ("" = unlabelled unit, named at display time). */
  label: string;
  variant: MarkerElement["variant"];
  color: string;
  /** Actions sorted by time. */
  actions: PlanTrackAction[];
}

/** Timeline view model: one track per unit, ordered by each unit's first
 *  action (ties broken by key) so rows never reshuffle while editing. */
export function planTracks(elements: TacticalElement[]): PlanTrack[] {
  const tweens = planTweenTargets(elements);
  const tracks: PlanTrack[] = [];
  for (const [key, actions] of groupByUnit(elements)) {
    const sorted = [...actions].sort((a, b) => a.t0 - b.t0);
    tracks.push({
      key,
      label: sorted[0].label,
      variant: sorted[0].variant,
      color: sorted[0].color,
      actions: sorted.map((el) => {
        const end = tweens.get(el.id);
        return {
          id: el.id,
          t: el.t0,
          kind: el.action ?? "move",
          ...(end ? { tweenEndT: end.t } : {}),
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
