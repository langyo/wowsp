/**
 * Capture-zone classification + domination scoring rules for the
 * holographic map, extracted verbatim from HolographicMap.tsx: the replay
 * stream test that separates real capture points from strike/event zones,
 * the official scoring parameter tables, and the CapZoneState shape the UI
 * (rings, scorebar, ETA chips) renders from.
 */
import type { EntityTrajectory } from "@/api";

// The capture-zone entities + their ownership timelines. InteractiveZone
// (type 14) covers ALL interactive areas — capture points, strike zones,
// event regions. The AUTHORITATIVE discriminator is the create packet's
// `controlPoint` component (`controlPointIndex`): only real domination
// points carry it, and it ships with the EntityCreate itself, so the rule
// holds even for replays that record no ownership/progress updates after
// the zone spawns. The ownership/progress-stream checks below are kept
// only as a fallback for very old replays predating the component.
/**
 * True capture point vs event/strike zone, from the replay streams
 * themselves (the authoritative per-match source — a map can ship in
 * multiple versions, so game resources alone can't be trusted):
 *  - controlPoint component (create state) — always a real point
 *    (older clients; 15.7+ no longer ships it)
 *  - capSamples (ownership stream) — real point when present
 *  - capProgress DYNAMICS (15.7+ discriminator, measured on real
 *    dumps): a capture point's progress is a tug-of-war — dozens of
 *    samples (66..223 on a 2-cap Canada match) rising and falling as
 *    ships enter/leave/contest. Strike/event targets carry 2-3
 *    samples that decay monotonically from a high start (health-style,
 *    often >1000) straight to zero when destroyed. The old
 *    "ended-at-zero" heuristic rejected a real point whose final
 *    contest bled out — the very state "each side holds one point"
 *    ends in — which collapsed a 2-cap map to a single chip.
 */
export function isCaptureZone(t: EntityTrajectory): boolean {
  if (t.kind?.controlPointIndex != null) return true;
  if ((t.capSamples?.length ?? 0) > 0) return true;
  const cp = t.capProgress ?? [];
  if (cp.length === 0) return false;
  if (cp.length >= 10) return true; // living tug-of-war stream
  const first = cp[0].value;
  if (first >= 1000) return false; // strike-target health pool
  const last = cp[cp.length - 1].value;
  if (last > 0) return true;
  // Few samples ending at zero: only a point NOBODY ever touched stays
  // zero the whole match. Strike targets decay from non-zero.
  return !cp.some((s) => s.value > 0);
}

// ── Scoring rules (official: wiki.worldofwarships.com/Ship:Game_Modes) ──
// Domination Random/Co-op: 3 areas → start 300, +3 per completed capture,
// +3 every 5s per controlled area; 4 areas → start 200, +4, +4 every 9s.
// Capture duration 60s (1 ship) / 40s (2+ ships); contested by both teams
// freezes progress; being hit halves the accrued progress.
// Eight maps override everything: start 150, kills +40, deaths -25.
export const SPECIAL_CAP_MAPS = new Set([
  "13_OC_new_dawn",
  "17_NA_fault_line",
  "23_Shards",
  "41_Conquest",
  "42_Neighbors",
  "52_Britain",
  "53_Shoreside",
  "54_Faroe",
]);
// Kill/death points by ship class (Random & Co-op).
export const KILL_PTS: Record<string, { kill: number; death: number }> = {
  Submarine: { kill: 25, death: -40 },
  Destroyer: { kill: 30, death: -45 },
  Cruiser: { kill: 35, death: -50 },
  Battleship: { kill: 40, death: -60 },
  AirCarrier: { kill: 45, death: -65 },
};

export interface CapZoneState {
  letter: string;
  owner: number; // 0 neutral, 1 ally, 2 enemy
  /** 0..1 progress of the current capture towards the capturing team. */
  progress: number;
  /** Ships of each side inside the point right now. */
  alliesIn: number;
  enemiesIn: number;
  /** true when both teams are inside (progress frozen). */
  contested: boolean;
  /** true when a capture is actively progressing. */
  capturing: boolean;
  /** Capturing team's progress speed: 1/60 or 1/40 per second. */
  speed: number;
  /** Capturing team (1/2) when capturing. */
  captureTeam: number;
  /** Seconds to finish if the situation holds (null when paused). */
  etaSeconds: number | null;
}
