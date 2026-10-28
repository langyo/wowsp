/** Decision-AI suggestion domain (experiment G4, composed into `api` by
 *  client.ts): fire-decision suggestions for one replay instant, served by
 *  commands/decision_serve.rs. Mirrors `wowsp_tauri_shared`'s wire types. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** One ship's fire-decision suggestion at one instant (G4). */
export interface DecisionSuggestion {
  entityId: number;
  shipId: number | null;
  /** Recorder-relative team: 0 = recorder's side, 1 = enemy; null when the
   *  shipId could not be attributed (only possible on the recorder row). */
  teamId: 0 | 1 | null;
  /** Whether this row is the replay's recorder (the UI highlights it). */
  isRecorder: boolean;
  /** Head-A logit "physically able to fire" (saturated ±1 on fixture models). */
  canFireLogit: number;
  /** Head-B logit "expert would fire now". */
  fireLogit: number;
  /** sigmoid(fireLogit), always in [0, 1]. */
  fireProb: number;
  /** Nearest observed-now enemy within engagement range, null when none. */
  targetEntityId: number | null;
  /** Distance to the target in metres. */
  targetDistanceM: number | null;
}

/** The `decision_fire_suggestions` payload — one row per qualifying decider
 *  at one instant, ordered by entity id. */
export interface DecisionSuggestionReport {
  timeSec: number;
  mapName: string | null;
  /** "pack" (decisions model pack) | "fixture" (embedded E1 dummy — treat
   *  the numbers as placeholders and show a demo badge). */
  modelSource: "pack" | "fixture";
  /** Provenance detail: the pack file's path or the fixture label. */
  modelDetail: string;
  /** "fire24" (E9 two-head schema) | "fixture8" (E1 dummy schema). */
  modelKind: "fire24" | "fixture8";
  /** Whether a terrain-LOS raster was loaded for this map. */
  losGridLoaded: boolean;
  /** Rows ordered by entityId ascending. */
  suggestions: DecisionSuggestion[];
}

/** Installed `decisions` model-pack inventory. Mirrors
 *  `wowsp_tauri_shared::DecisionsPackStatus`. */
export interface DecisionsPackStatus {
  present: boolean;
  dir: string;
  sizeBytes: number;
  modelPresent: boolean;
  modelBytes: number;
  /** Map short names that carry a `terrain_los.npz` raster. */
  losMaps: string[];
}

// ── E18 · G6 step 3: the AI analysis debug report ───────────────────────────

/** One ship's movement advice at one instant (the E16 17-class move model
 *  over that ship's latest decision row at or before `timeSec`). */
export interface MovementAdvice {
  entityId: number;
  shipId: number | null;
  /** Recorder-relative team: 0 = recorder's side, 1 = enemy. */
  teamId: 0 | 1;
  isRecorder: boolean;
  /** Decision time of the underlying row (≤ timeSec, ≤ 8 s stale). */
  rowT: number;
  /** Argmax sector: 0..15 directional (22.5° each, 0 = dead ahead of the
   *  ship's heading), 16 = no-move. */
  topSector: number;
  topProb: number;
  /** The full 17-class softmax (sums to 1). */
  probDist: number[];
  /** Absolute map bearing of the top sector (radians, atan2(dz, dx) frame),
   *  `null` for the no-move class. */
  mapBearingRad: number | null;
  secondSector: number;
  secondProb: number;
}

/** One instant's decomposed score (E17). `fire` is null on non-can-fire
 *  rows (no fire decision was on the table). */
export interface ShipScoreSample {
  t: number;
  inst: number;
  fire: number | null;
  move: number;
  /** Independent output: the models' own certainty (NOT the score). */
  confidence: number;
}

/** Post-battle ground truth joined from BattleResults by shipId. */
export type ShipOutcome =
  | {
      status: "ok";
      damage: number;
      baseExp: number | null;
      frags: number;
      survived: boolean;
    }
  | { status: "ambiguous" }
  | { status: "missing" }
  | { status: "noShipId" };

/** One ship's whole-game score entry (E17). */
export interface ShipScoreEntry {
  entityId: number;
  shipId: number | null;
  /** Recorder-relative team: 0 = recorder's side, 1 = enemy. */
  teamId: 0 | 1;
  isRecorder: boolean;
  /** Row (== time) mean of the instant score — MODEL AGREEMENT, not skill
   *  (E17: ρ=+0.011 vs damage; the UI must carry the disclaimer). */
  wholeGame: number;
  /** Mean fire agreement over can-fire samples; null when none. */
  wholeFire: number | null;
  wholeMove: number;
  samples: ShipScoreSample[];
  outcome: ShipOutcome;
}

/** The full-timeline E17 score report embedded in the debug report. */
export interface ShipScoreReport {
  replayId: string;
  mapName: string | null;
  gameMode: string | null;
  replayVersion: string | null;
  /** Ordered by entity id. */
  perShip: ShipScoreEntry[];
  modelSources: { fire: string; moveModel: string };
  stats: {
    shipsScored: number;
    rowsScored: number;
    rowsCanFire: number;
    rowsFired: number;
    rowsNoMove: number;
  };
}

/** The `decision_debug_report` payload: movement advice for the instant +
 *  the embedded full-timeline score report. A cold call costs a replay
 *  export + decode + two full model passes (seconds); the artifacts are
 *  cached in-process, so later calls only re-run the movement forwards. */
export interface DecisionDebugReport {
  timeSec: number;
  mapName: string | null;
  /** Provenance of the two models (path or label). */
  fireModel: string;
  moveModel: string;
  /** "env" (debug override) | "pack" (decisions pack) | "experiments"
   *  (local out/ default). */
  fireModelOrigin: "env" | "pack" | "experiments" | "unknown";
  moveModelOrigin: "env" | "pack" | "experiments" | "unknown";
  losGridLoaded: boolean;
  cached: boolean;
  elapsedMs: number;
  movement: MovementAdvice[];
  scores: ShipScoreReport;
}

export const decisionApi = {
  /** Fire-decision suggestions for one replay instant. `losGridDir` is
   *  optional (defaults to the installed `decisions` pack's raster layout);
   *  resolves or fails with a string error — callers render failures
   *  silently. */
  decisionFireSuggestions: (replayPath: string, timeSec: number, losGridDir?: string) =>
    transport.invoke<DecisionSuggestionReport>(RPC.decision_fire_suggestions, {
      replayPath,
      timeSec,
      losGridDir: losGridDir ?? null,
    }),
  /** The E18 AI analysis debug report: movement advice at `timeSec` + the
   *  full-timeline E17 score report. Heavy on the first call (cached
   *  afterwards); `losGridDir` defaults to the decisions pack layout. */
  decisionDebugReport: (replayPath: string, timeSec: number, losGridDir?: string) =>
    transport.invoke<DecisionDebugReport>(RPC.decision_debug_report, {
      replayPath,
      timeSec,
      losGridDir: losGridDir ?? null,
    }),
  /** Filesystem-only inventory of `<cache>/decisions` (no ORT session). */
  decisionsPackStatus: () =>
    transport.invoke<DecisionsPackStatus>(RPC.decisions_pack_status),
  /** Remove the installed decisions pack (a loaded model stays in memory
   *  until restart). */
  clearDecisionsPack: () => transport.invoke<null>(RPC.clear_decisions_pack),
};
