/**
 * Replay camera-mode stream (0x27 CameraMode) semantics for the holographic
 * map's aircraft-follow camera.
 *
 * The decoder records every CameraMode packet as an HpSample ({ time, value })
 * whose `value` is the raw u32 mode id (see replay_core's parse_camera_mode).
 * The id table mirrors the client's GameParams CAMERA_MODES constants /
 * game-assets-core's CameraMode enum; it is frozen here as the DEFAULT table
 * so the webui can label a replay's recorded view without a GameParams
 * lookup. Unknown ids (other client builds, dev-only modes) answer null.
 * KEEP IN SYNC with the Rust authority:
 * packages/tools/game-assets-core/src/game_constants.rs (BattleConstants'
 * default camera_modes map, ids 1..23) — that map is the source of truth if
 * a client build ever reorders the enum.
 *
 * Pure module — no Vue / DOM / three.js state, unit-testable on plain samples.
 */
import type { HpSample } from "@/api";

/** Semantic name of one recorded camera mode (see the id table below). */
export type RecordedCameraMode =
  | "airplanes"
  | "dock"
  | "overheadMap"
  | "devFree"
  | "followingShells"
  | "followingPlanes"
  | "dockModule"
  | "followingShip"
  | "freeFlying"
  | "replayFpc"
  | "followingSubmarine"
  | "tacticalConsumables"
  | "respawnMap"
  | "dockFlags"
  | "dockEnsign"
  | "dockLootbox"
  | "dockNavalFlag"
  | "idleGame";

/** Default 0x27 raw id → semantic name table (the client's CAMERA_MODES
 *  values; ids 14–18 exist in no known client build and stay unknown). */
const CAMERA_MODE_NAMES: Readonly<Record<number, RecordedCameraMode>> = {
  1: "airplanes",
  2: "dock",
  3: "overheadMap",
  4: "devFree",
  5: "followingShells",
  6: "followingPlanes",
  7: "dockModule",
  8: "followingShip",
  9: "freeFlying",
  10: "replayFpc",
  11: "followingSubmarine",
  12: "tacticalConsumables",
  13: "respawnMap",
  19: "dockFlags",
  20: "dockEnsign",
  21: "dockLootbox",
  22: "dockNavalFlag",
  23: "idleGame",
};

/** Map a raw 0x27 camera-mode id to its semantic name; unknown / missing /
 *  non-integer ids answer null. Null means "this caller cannot name the
 *  mode" — callers that must tell an unknown mode from "no samples yet"
 *  read cameraModeIdAt directly. */
export function recordedCameraMode(
  id: number | null | undefined,
): RecordedCameraMode | null {
  if (id == null || !Number.isInteger(id)) return null;
  return CAMERA_MODE_NAMES[id] ?? null;
}

/** Plane-camera modes — the recorded view was framing aircraft: the CV
 *  player's in-squadron "airplanes" view and the spectator
 *  "followingPlanes" chase. Both open / extend an aircraft-camera window
 *  (see planeCameraWindows); switching between the two is NOT a break. */
export function isPlaneCameraMode(
  mode: RecordedCameraMode | null | undefined,
): boolean {
  return mode === "airplanes" || mode === "followingPlanes";
}

/** Raw camera-mode id at playhead t: the value of the last sample at or
 *  before t (step semantics, like every other 0x27 / HP stream consumer).
 *  Null when the stream is empty or t precedes its first sample — the
 *  recorded view is unknown there, never extrapolated backwards. Binary
 *  search: runs per rendered frame. Samples must be ascending by time (the
 *  decoder appends chronologically). */
export function cameraModeIdAt(
  samples: HpSample[] | undefined,
  t: number,
): number | null {
  if (!samples || samples.length === 0) return null;
  if (t < samples[0].time) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return samples[lo].value;
}

/** Semantic camera mode at playhead t (cameraModeIdAt + the default table).
 *  Null both before the first sample and for an unknown raw id. */
export function cameraModeAt(
  samples: HpSample[] | undefined,
  t: number,
): RecordedCameraMode | null {
  return recordedCameraMode(cameraModeIdAt(samples, t));
}

/** One continuous stretch of recorded aircraft-camera time. `start` is the
 *  sample time that entered the first plane mode (inclusive); `end` is the
 *  time of the mode change that left it (exclusive — the recorded view is
 *  already elsewhere there), the last window closing at the replay
 *  `duration`. `id` is the raw u32 id of the sample that OPENED the window
 *  (an airplanes↔followingPlanes crossing stays one window, so `id` names
 *  the head mode). Zero-length windows (a mode flip and back on the same
 *  timestamp, a window starting past `duration`) are dropped. */
export interface PlaneCameraWindow {
  start: number;
  end: number;
  id: number;
}

/** Recorded aircraft-camera segments of the replay, in playhead order. */
export function planeCameraWindows(
  samples: HpSample[] | undefined,
  duration: number,
): PlaneCameraWindow[] {
  const out: PlaneCameraWindow[] = [];
  if (!samples || samples.length === 0) return out;
  const dur = Math.max(0, duration);
  let openStart = -1;
  let openId = 0;
  for (const sample of samples) {
    if (isPlaneCameraMode(recordedCameraMode(sample.value))) {
      if (openStart < 0) {
        openStart = sample.time;
        openId = sample.value;
      }
    } else if (openStart >= 0) {
      // Clip the closing edge to the replay duration: a mode change recorded
      // past the decoded horizon must not produce a window whose end (or
      // whole span) lies beyond the playable clock, or "jump to nearest"
      // would seek outside the replay.
      const end = Math.min(sample.time, dur);
      if (end > openStart) {
        out.push({ start: openStart, end, id: openId });
      }
      openStart = -1;
    }
  }
  if (openStart >= 0 && dur > openStart) {
    out.push({ start: openStart, end: dur, id: openId });
  }
  return out;
}

/** The recorded aircraft-camera window nearest to `t`: the containing
 *  window when the playhead sits inside one ([start, end] — a boundary
 *  counts as inside), otherwise the closest one by distance to that
 *  interval. Ties resolve to the earlier window. Null = no aircraft-camera
 *  segment at all (the replay was never recorded in a plane view). */
export function nearestPlaneCameraWindow(
  samples: HpSample[] | undefined,
  duration: number,
  t: number,
): PlaneCameraWindow | null {
  let best: PlaneCameraWindow | null = null;
  let bestDist = Infinity;
  for (const win of planeCameraWindows(samples, duration)) {
    const dist = t < win.start ? win.start - t : t > win.end ? t - win.end : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = win;
    }
  }
  return best;
}
