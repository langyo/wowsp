/**
 * Score + lamp helpers for the replay roster overlay: the playhead
 * instant-score lookup (binary search over the per-ship sample series the
 * `decision_debug_report` RPC embeds), the compact contribution formatter,
 * and the CONTINUOUS red → yellow → green AI-agreement lamp colour.
 *
 * Moved here from the retired HoloScorePanel sidebar (the hold-Tab roster
 * is the only consumer left); pure data-in/data-out — no Vue, no DOM — so
 * the helpers stay unit-testable.
 */
import type { ShipScoreSample } from "@/api";

/** Last sample at or before `t` (series are t-sorted) — the instant score
 *  the roster reads at the playhead. Null before the ship's first decision
 *  point (the battle has not reached it yet). */
export function scoreSampleAt(
  samples: ShipScoreSample[],
  t: number,
): ShipScoreSample | null {
  let lo = 0;
  let hi = samples.length - 1;
  let best: ShipScoreSample | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) {
      best = samples[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Compact damage rendering for the contribution column: 84.2k / 1.31M,
 *  raw numbers below 1000 (WoWS whole-game contributions rarely reach M). */
export function formatContribution(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toString();
}

/** Clamp an agreement value into 0..1. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Continuous AI-agreement lamp hue: 0 = red (inst 0), 60 = yellow
 *  (inst 0.5), 120 = green (inst 1.0). A continuous HSL interpolation —
 *  never three fixed buckets. */
export function aiLampHue(inst: number): number {
  return clamp01(inst) * 120;
}

/** CSS colour for the roster's agreement lamp — the same continuous hue at
 *  a fixed saturation/lightness so only the colour conveys the score. */
export function aiLampColor(inst: number): string {
  return `hsl(${aiLampHue(inst).toFixed(1)} 78% 55%)`;
}
