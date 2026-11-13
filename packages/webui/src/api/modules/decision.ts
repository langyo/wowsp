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
  modelSource: "pack" | "fixture" | "env" | "dev";
  /** Provenance detail: the pack file's path or the fixture label. */
  modelDetail: string;
  /** "fire24" (E9 two-head schema) | "fixture8" (E1 dummy schema). */
  modelKind: "fire24" | "fixture8";
  /** Whether a terrain-LOS raster was loaded for this map. */
  losGridLoaded: boolean;
  /** Rows ordered by entityId ascending. */
  suggestions: DecisionSuggestion[];
}


// ── E25 · static per-player decision report ─────────────────────────────

/** Data availability over the alive interval (mirrors StaticCoverage). */
export interface StaticCoverage {
  aliveFrom: number;
  aliveTo: number;
  samples: number;
  gapSeconds: number;
  completeness: number;
  /** [from, to] battle-second segments the player was unresolvable. */
  gapSegments: [number, number][];
}

/** One hull's torpedo-decision diagnostics (E26 / P2 torpedo model).
 *  A SEPARATE dimension BY DESIGN: it never folds into `wholeGame`, the
 *  contribution or any ranking — the head-B base rate is ~1.6 %, and the
 *  mean-type aggregation E17/E20 showed saturates into a meaningless
 *  "everyone agrees" face. The card is a diagnostic, not a rating. */
export interface TorpedoScores {
  /** E17-style mean agreement over the can-launch windows, [0, 1]. */
  agreement: number;
  /** Mean head-B p(launch) over those windows, [0, 1]. */
  meanProb: number;
  /** Can-launch windows scored — the opportunity VOLUME behind the means
   *  (E20's lesson: keep the volume next to the saturated mean). */
  canLaunchWindows: number;
  /** Launch actions actually taken inside those windows. */
  launches: number;
  /** Conditional expected effectiveness: mean headC P(hit | launched) over
   *  the LAUNCHED windows, [0, 1]. `null` when the installed model has no
   *  third head (legacy torp2 two-head export), the ship never launched, or
   *  the context predates T4 — the card HIDES the row then, it never renders
   *  a fabricated 0 %. DIAGNOSTIC ONLY: the hit labels are a proxied
   *  fish-level signal, not a hit rate. */
  effectiveness: number | null;
}

/** Whole-game headline numbers (E21/E22 semantics). */
export interface StaticWholeScores {
  wholeGame: number;
  wholeFire: number | null;
  wholeMove: number;
  contribution: number | null;
  contributionShots: number | null;
  /** Torpedo diagnostics — null when the torpedo model is not installed or
   *  the hull's class is not torpedo-applicable (CV / unknown). Never part
   *  of `wholeGame`. */
  torpedo: TorpedoScores | null;
}

/** Why a moment was selected (drives the localized caption). */
export type StaticMomentCategory =
  | "damageRealized"
  | "missedOpportunity"
  | "forcedShot"
  | "strongWindow"
  | "weakWindow";

/** Nearest observed enemy snapshot. */
export interface StaticEnemySnapshot {
  entityId: number;
  distM: number;
  bearingRelRad: number;
  inRange: boolean;
}

/** One dissected key decision. */
export interface StaticMoment {
  t: number;
  category: StaticMomentCategory;
  weight: number;
  hpFrac: number | null;
  speedKt: number | null;
  enemiesObserved: number;
  nearestEnemy: StaticEnemySnapshot | null;
  fired: boolean | null;
  fireProb: number | null;
  moveSector: number;
  advisedSector: number;
  advisedProb: number;
  inst: number;
  fireAlignment: number | null;
  moveAlignment: number;
  confidence: number;
  hpLostWindow: number | null;
  hpFracAfter: number | null;
}

/** One roster row (the perspective picker). */
export interface StaticRosterEntry {
  entityId: number;
  shipId: number | null;
  /** Ship class from the model pack's class vocabulary ("AirCarrier",
   *  "Submarine", "Battleship", …) — null when the hull could not be
   *  attributed to a class. */
  shipClass: string | null;
  /** Whether the fire-decision model covers this ship class. False for
   *  AirCarrier / Submarine: the full training corpus holds zero positive
   *  fire examples for them, so the fire component and the contribution
   *  stay null and the whole-game score degrades to movement alone. */
  fireApplicable: boolean;
  /** Whether the torpedo-decision model applies to this hull (Submarine /
   *  destroyer / …; false for AirCarrier and unknown classes). */
  torpedoApplicable: boolean;
  name: string | null;
  /** The PLAYER nickname (the replay roster vehicle's own name) — the join
   *  key the post-battle panel's BattleResults rows match against, where
   *  `name` (ship-name-preferred, display-facing) cannot serve. */
  playerName: string | null;
  teamId: 0 | 1;
  isRecorder: boolean;
  diedAt: number | null;
  coverage: StaticCoverage;
  whole: StaticWholeScores | null;
  outcome: unknown;
}

/** The full static report (mirrors the Rust StaticReport). */
export interface StaticReport {
  replayPath: string;
  replayId: string;
  mapName: string | null;
  gameMode: string | null;
  durationS: number;
  losLoaded: boolean;
  /** Model provenance. `torpedoModel` is the E26/T4 torpedo model path,
   *  null when no model is installed (the report then shows N/A). Since T4
   *  the string carries a CONTRACT SUFFIX, e.g.
   *  `"<origin>:<path> [torp4/g49/3head]"` (legacy two-head exports read
   *  `[torp2/g38/2head]`) — display it verbatim, never compare it by value. */
  modelSources: {
    fire: string;
    moveModel: string;
    torpedoModel: string | null;
  };
  entityId: number;
  /** Set only when the DEFAULT perspective (the recorder) had no scoreable
   *  rows and the report fell back to the best-covered hull: the skipped
   * default's entity id. Absent when no fallback happened or the entity
   * was requested explicitly (Rust emits it only when Some). */
  fallbackFrom?: number | null;
  roster: StaticRosterEntry[];
  /** The chosen player's 4 s score grid (mirrors Rust `ShipScoreSample`):
   *  the fire model only scored can-fire rows, the move model every row. */
  timeline: {
    t: number;
    inst: number;
    /** p(actual fire action) — null on non-can-fire rows. */
    fire: number | null;
    /** Whether the ship actually fired in the label window — null off
     *  can-fire rows. */
    fired: boolean | null;
    /** Raw p(expert fires) — null off can-fire rows. */
    fireProb: number | null;
    /** Enemy HP lost in the label window attributed to this ship — null off
     *  can-fire rows. */
    hpLost: number | null;
    /** Softmax mass on the actual move sector. */
    move: number;
    confidence: number;
  }[];
  moments: StaticMoment[];
}


/** Installed `decisions` model-pack inventory. Mirrors
 *  `wowsp_tauri_shared::DecisionsPackStatus`. */
export interface DecisionsPackStatus {
  present: boolean;
  dir: string;
  sizeBytes: number;
  modelPresent: boolean;
  modelBytes: number;
  /** Whether `move_model.onnx` is installed (older packs carry only fire). */
  moveModelPresent: boolean;
  moveModelBytes: number;
  /** Whether `advice_fire_model.onnx` is installed (E24 advice chain;
   *  optional — the board falls back to the scoring fire model). */
  adviceModelPresent: boolean;
  adviceModelBytes: number;
  /** Whether the legacy two-head `torpedo_model.onnx` is installed (E26/P2
   *  torpedo model; optional — the report shows N/A without any torpedo
   *  model). Kept as the FALLBACK slot for older packs. */
  torpedoModelPresent: boolean;
  torpedoModelBytes: number;
  /** Whether the T4 three-head `torpedo4_model.onnx` is installed (49-dim
   *  contract; preferred over the legacy two-head slot). Old packs omit the
   *  field (`#[serde(default)]`). */
  torpedo4ModelPresent: boolean;
  torpedo4ModelBytes: number;
  /** Map short names that carry a `terrain_los.npz` raster. */
  losMaps: string[];
}

/** Local install state of the AI model channel (Hugging Face manifest).
 *  Mirrors `wowsp_tauri_shared::AiPackStatus`. */
export interface AiPackModelState {
  path: string;
  present: boolean;
  sizeBytes: number;
}

export interface AiPackStatus {
  installed: boolean;
  seq: number | null;
  version: string | null;
  treeSha256: string | null;
  revision: string | null;
  installedAt: string | null;
  sizeBytes: number;
  losMaps: number;
  /** The release shipped LOS rasters but the res pack no longer matched,
   *  so they were skipped (update the resource pack, then re-check). */
  losSkipped: boolean;
  models: AiPackModelState[];
}

/** One runtime file of the authenticated remote manifest. */
export interface AiPackFileInfo {
  path: string;
  size: number;
  sha256: string;
  kind?: string;
  featureSet?: string;
}

/** One authenticated manifest check (`ai_pack_check`). */
export interface AiPackCheck {
  current: AiPackStatus;
  latestSeq: number;
  latestVersion: string;
  latestTreeSha256: string;
  latestRevision: string;
  totalBytes: number;
  losIncluded: boolean;
  /** The published LOS rasters were baked against a different res pack;
   *  the download would install the models only. */
  losMismatch: boolean;
  files: AiPackFileInfo[];
  endpoint: string;
  manifestSha256: string;
  checkedAt: string;
  updateAvailable: boolean;
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
  /** Whether the ship actually fired in the label window (null off
   *  can-fire rows) — E20's opportunity-capture aggregation substrate. */
  fired: boolean | null;
  /** Head-B raw p(expert fires) (null off can-fire rows); `fire` is
   *  `fired ? fireProb : 1 - fireProb`. */
  fireProb: number | null;
  /** Enemy HP lost in the (t+2, t+45]s window attributable to this ship's
   *  covering impacts (E13 semantics) — null off can-fire rows. */
  hpLost: number | null;
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
  /** Ship class from the model pack's class vocabulary ("AirCarrier",
   *  "Submarine", "Battleship", …) — null when the hull could not be
   *  attributed to a class. */
  shipClass: string | null;
  /** Whether the fire-decision model covers this ship class. False for
   *  AirCarrier / Submarine: the full training corpus holds zero positive
   *  fire examples for them, so the fire component and the contribution
   *  stay null and the whole-game score degrades to movement alone. */
  fireApplicable: boolean;
  /** Whether the torpedo-decision model applies to this hull (P2 contract). */
  torpedoApplicable: boolean;
  /** Torpedo diagnostics — an INDEPENDENT dimension: never part of
   *  `wholeGame`/the contribution and never used for ranking. Null when the
   *  model is missing, the hull is not torpedo-applicable, or no can-launch
   *  row was scored. */
  torpedo: TorpedoScores | null;
  /** Recorder-relative team: 0 = recorder's side, 1 = enemy. */
  teamId: 0 | 1;
  isRecorder: boolean;
  /** Row (== time) mean of the instant score — MODEL AGREEMENT, not skill
   *  (E17: ρ=+0.011 vs damage; the UI must carry the disclaimer). */
  wholeGame: number;
  /** Mean fire agreement over can-fire samples; null when none. */
  wholeFire: number | null;
  wholeMove: number;
  /** E21's validated whole-game semantic: enemy HP lost in the fired
   *  decision windows, attributed to this ship's covering impacts
   *  (confirmation rho +0.477 vs battle damage). Null when never fired. */
  contribution: number | null;
  /** Fired can-fire windows behind `contribution`. */
  contributionShots: number | null;
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
  /** Torpedo model provenance (P2/T4 contract) — null when no model is
   *  installed; the torpedo block is then null for every ship. Since T4 the
   *  string carries a contract suffix (`... [torp4/g49/3head]` or the
   *  legacy `[torp2/g38/2head]`): display verbatim, never compare by
   *  value. */
  torpedoSource: string | null;
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

/** Upper bound on ONE `decision_static_report` round trip. The command runs
 *  a full replay decode + the scoring pass on the backend blocking pool
 *  (multi-second on a cold replay, cached afterwards), but the invoke has no
 *  timeout of its own: a stalled `ipc.localhost` round trip — the wedge
 *  class `utils/ipcGuard.ts` probes for at startup — would otherwise pin a
 *  host's spinner forever. Same rule as the results pill's stream read
 *  (`features/replay/useReplayPositions.ts`): the watchdog settles the
 *  VISIBLE state on expiry instead of the await; the seq stays current, so a
 *  late cached answer can still land and upgrade the panel in place. */
export const STATIC_REPORT_READ_TIMEOUT_MS = 30_000;

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
  /** E25 static per-player decision report (any roster perspective; the
   *  Rust side shares the debug-report scoring cache). */
  decisionStaticReport: (
    replayPath: string,
    entityId: number | null,
    losGridDir?: string,
  ) =>
    transport.invoke<StaticReport>(RPC.decision_static_report, {
      replayPath,
      entityId: entityId ?? null,
      losGridDir: losGridDir ?? null,
    }),
  /** Filesystem-only inventory of `<cache>/decisions` (no ORT session). */
  decisionsPackStatus: () =>
    transport.invoke<DecisionsPackStatus>(RPC.decisions_pack_status),
  /** Remove the installed decisions pack (a loaded model stays in memory
   *  until restart). */
  clearDecisionsPack: () => transport.invoke<null>(RPC.clear_decisions_pack),
  /** Local install state of the Hugging Face published model pack. */
  aiPackStatus: () => transport.invoke<AiPackStatus>(RPC.ai_pack_status),
  /** Fetch + authenticate the published manifest (no download). */
  aiPackCheck: () => transport.invoke<AiPackCheck>(RPC.ai_pack_check),
  /** Download + verify + install the published pack (progress on the
   *  unified download-progress bus, kind "ai-models"). */
  aiPackDownload: () => transport.invoke<null>(RPC.ai_pack_download),
  /** Cancel the running install pass. */
  aiPackCancel: () => transport.invoke<null>(RPC.ai_pack_cancel),
};
