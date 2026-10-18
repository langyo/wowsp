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
  /** Filesystem-only inventory of `<cache>/decisions` (no ORT session). */
  decisionsPackStatus: () =>
    transport.invoke<DecisionsPackStatus>(RPC.decisions_pack_status),
  /** Remove the installed decisions pack (a loaded model stays in memory
   *  until restart). */
  clearDecisionsPack: () => transport.invoke<null>(RPC.clear_decisions_pack),
};
