/**
 * capTimer — shared capture-point timing rules.
 *
 * The app and the marketing site both show the in-game point timers (ETA to
 * capture, ETA to reach, hit penalties) — these are that one implementation,
 * packaged so neither side re-derives the rules.
 *
 * Game rules modelled (matching the client's point widget):
 *  - a neutral/contested point captures in 60s with one ship inside, 30s
 *    with two or more (extra ships beyond the second add nothing)
 *  - both teams inside → progress frozen (contested)
 *  - a direct hit inside the point removes ~30s of accrued progress; a
 *    partial hit (overpen / water hit) removes ~15s
 * Where the replay stream provides real values (ownership changes, progress),
 * those win; these constants are the shared fallback both UIs display.
 */

/** Seconds to capture a fully-neutral point with a single ship inside. */
export const CAP_SECONDS_ONE = 60;
/** Seconds to capture with two or more ships inside (halved). */
export const CAP_SECONDS_TWO = 30;
/** Direct hit inside the point: accrued progress removed (seconds). */
export const HIT_PENALTY_HARD_SECONDS = 30;
/** Partial hit (overpen/water): accrued progress removed (seconds). */
export const HIT_PENALTY_SOFT_SECONDS = 15;

/** Capture speed (progress per second) for a given number of capturing ships. */
export function captureSpeedPerSec(shipsInside: number): number {
  return shipsInside >= 2 ? 1 / CAP_SECONDS_TWO : 1 / CAP_SECONDS_ONE;
}

export interface CapEta {
  /** Seconds left until the point flips, or null (not capturing / frozen). */
  seconds: number | null;
  /** True while both teams are inside (progress paused by the game). */
  contested: boolean;
}

/**
 * Remaining capture time for a point under capture.
 * `progress` 0..1, `capturingShips` = ships of the capturing team inside.
 */
export function captureSecondsRemaining(
  progress: number,
  capturingShips: number,
  contested: boolean,
): CapEta {
  if (contested || capturingShips <= 0 || progress >= 1) {
    return { seconds: null, contested: !!contested };
  }
  const speed = captureSpeedPerSec(capturingShips);
  return { seconds: Math.ceil((1 - progress) / speed), contested: false };
}

/** Seconds for a ship at `speed` to cover `dist` (null when not moving). */
export function reachSeconds(dist: number, speed: number): number | null {
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return Math.ceil(dist / speed);
}

/** Remove a hit penalty from captured progress (clamped to 0). */
export function applyHitPenalty(
  progress: number,
  severity: "hard" | "soft",
  capturingShips: number,
): number {
  const seconds = severity === "hard" ? HIT_PENALTY_HARD_SECONDS : HIT_PENALTY_SOFT_SECONDS;
  return Math.max(0, progress - seconds * captureSpeedPerSec(capturingShips));
}

/** Compact timer text ("42s" / "1:05") for point HUDs. */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
