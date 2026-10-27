/**
 * Decode-time spawn-symmetry probe — the WEAK, supplemental 行动 (operation)
 * signal for the OPENED replay.
 *
 * WHY THIS EXISTS
 * ---------------
 * The descriptor/roster classifier (utils/modeColors.ts) is authoritative:
 * eventType / scenario / matchGroup / roster shape decide the mode label.
 * Two surfaces cannot see the decoded packet stream at all (the replay-list
 * scan only reads the descriptor), so that classifier is all they have.
 * The viewer, however, decodes the battle — and the user supplied one extra
 * decode-time criterion for the residual tail the descriptor cannot classify:
 *
 *   In co-op / PvP both fleets spawn in ROUGHLY MIRRORED clusters (the map's
 *   spawn zones are laid out symmetrically), whereas a scripted operation
 *   (行动) spawns its enemy ships progressively along scripted paths — wave
 *   after wave, all over the map — so the enemy spawn cloud is NOT a mirror
 *   of the ally spawn cloud.
 *
 * This module answers only that geometric question. It is deliberately
 * conservative and one-directional: callers may PROMOTE a plain co-op label
 * to operation when the result is clearly `symmetric: false`, and must leave
 * every other verdict (true / null) alone. It never demotes operation -> co-op.
 *
 * MODEL
 * -----
 * Central (180°) symmetry. Let ca / ce be the two sides' spawn centroids and
 * c = (ca + ce) / 2 the estimated symmetry centre (so the test is invariant
 * to where the two clusters sit and how far apart they are). Every enemy
 * spawn e is mirrored through c -> 2c - e, and counts as MATCHED when an ally
 * spawn lies within `tolerance` of the mirrored point. matchFraction is the
 * matched share of the enemy spawns.
 *
 * Verdicts (both sides need >= 2 spawns — a single point estimates nothing):
 *   - true  when matchFraction >= 0.6 — the enemy cloud sits where the mirror
 *     of the ally cloud is (the broad "mirrored fleets" shape);
 *   - false when matchFraction <= 0.5 — CLEARLY one-sided: at most half of the
 *     enemy spawns mirror ANY ally spawn. The 0.5 cut is a conservative
 *     heuristic initial value (NOT the task sketch's "~0.25" first guess and
 *     NOT an audited calibration — see DEFAULT VALUES below);
 *   - null  otherwise (ambiguous, or not enough spawns) — callers must not act.
 *
 * TOLERANCE
 * ---------
 * Replay world positions are BigWorld distance units (1 unit = 30 m — the
 * M_PER_WORLD_UNIT constant in features/holographic/weather.ts; map bounds
 * are normalized to roughly ±400..±800 units in minimaps.json, so the scale
 * is consistent across maps). The tolerance is expressed in METRES for the
 * API (a 9 km floor plus 0.25 * mean cluster radius) — the floor is large
 * because the probe is NOT comparing exact mirrored spawn points: enemy
 * EntityCreate packets land when the client first observes the ship, which
 * in fleet battles is 1..4 km after it left spawn. The probe asks "is the
 * enemy cloud roughly the mirror image of the ally cloud?", not "does every
 * enemy ship have an ally twin".
 *
 * DEFAULT VALUES — WHAT WAS (AND WAS NOT) VALIDATED
 * -------------------------------------------------
 * The 9 km tolerance floor, the 0.6 symmetric cut and the 0.5 false cut are
 * HEURISTIC INITIAL DEFAULTS, not a published calibration. They were chosen
 * with a small, ad-hoc check on the development machine whose inputs were
 * the 60 replays in the local app-data archive (read-only; never copied into
 * the repo):
 *   - the repo's `replay-corpus calib` CLI (packages/tools/replay-corpus)
 *     decoded the archive to a LiveSelfStream NDJSON. That CLI emits decoded
 *     streams only — there is NO per-battle spawn/side dump in the repo;
 *   - a throwaway Node script (never committed) re-implemented the viewer's
 *     arena/roster side join, read each battle's roster from its replay
 *     header (arena state is absent in some recordings), and fed the shipped
 *     module.
 * There is NO committed calibration artifact and no reproducible harness in
 * the repo, so the numbers below must not be treated as audited. What that
 * check suggested: 39 two-sided fleet battles (random PvP + Halloween/brawl
 * events, 2..12 ships per side) all read symmetric === true with
 * matchFraction 0.80..1.00 at the default tolerance, while the single
 * scripted operation (the 2026-10-26 WW2 story replay,
 * `WW2_OPERATION_1_1011LVL`) read 0.39 under a validation-only side
 * resolution (the shipped resolver returns null on it: no arena state and
 * its scripted enemies carry no roster side).
 *
 * CRITICAL GAP: the archive contained NO plain-co-op replay — and plain
 * co-op is the ONLY class this probe may ever promote. The false-positive
 * band (a genuine co-op battle reading symmetric === false) is therefore
 * UNPROVEN. That is why the false cut stays low at 0.5 (against the observed
 * fleet minimum 0.8), why a verdict needs >= 2 spawns per side, and why
 * callers must act on a false verdict only for a plain-co-op descriptor
 * label. Re-measure the probe against a proper co-op dataset (ideally a
 * committed fixture) before widening its role; the task sketch's "~0.25
 * match fraction" cut is not supported either — real fleet first-observed
 * positions are already 1..4 km off the mirrored point.
 *
 * LIMITATIONS (documented by design)
 * ----------------------------------
 * - The replay-LIST scan cannot decode packets, so this probe is only
 *   available for the OPENED replay; list badges must keep the descriptor /
 *   roster classification.
 * - Side resolution is the caller's job (the viewer prefers the arena's
 *   authoritative team ids and falls back to a unique roster shipId join).
 *   When neither resolves an enemy side the probe returns null — operations
 *   whose scripted enemies are invisible to both joins simply stay
 *   unclassified here (the descriptor classifier is the primary fix).
 * - It is a heuristic: a co-op battle whose bots happen to appear in a very
 *   one-sided cloud could read false, and an operation whose waves happen to
 *   cluster opposite the ally spawns could read null. Only a clear false
 *   verdict may be acted on, and only for a plain-co-op label.
 */
import type { EntityTrajectory } from "@/api";

/** BigWorld distance unit → metres (mirrors features/holographic/weather.ts;
 *  duplicated here so this probe stays a self-contained pure module). */
const WORLD_UNIT_METERS = 30;

/** Minimum usable spawns PER SIDE before any verdict is allowed. */
const MIN_SPAWNS_PER_SIDE = 2;

/** matchFraction at or above this => symmetric (mirrored fleets). */
const DEFAULT_SYMMETRIC_AT = 0.6;

/** matchFraction at or below this => asymmetric (clearly one-sided). A
 *  conservative heuristic initial value — see the module doc's DEFAULT
 *  VALUES section for why it is 0.5 and why plain-co-op false positives are
 *  unproven. */
const DEFAULT_ASYMMETRIC_AT = 0.5;

/** Default absolute mirror tolerance in metres: 300 world units. A heuristic
 *  initial default, not a published calibration — see the module doc's
 *  DEFAULT VALUES section. */
export const DEFAULT_SPAWN_TOLERANCE_M = 300 * WORLD_UNIT_METERS;

/** Fraction of the mean spawn-cluster radius added to the tolerance floor so
 *  unusually scattered fleets are measured against their own spread. */
const CLUSTER_RADIUS_TOLERANCE_FRACTION = 0.25;

/** Which side an entity belongs to. The caller resolves it (arena team ids,
 *  roster relation, ...); `null` means "not a battle side" / unknown. */
export type EntitySide = "ally" | "enemy";

/** One usable spawn point, in replay world units (1 unit = 30 m). */
export interface SpawnPoint {
  entityId: number;
  /** World-space spawn position (x = east, z = north), replay units. */
  x: number;
  z: number;
  /** EntityCreate match time (s) when known (-1 = existed before the replay),
   *  else the first sample's time. Diagnostics only — never part of the
   *  verdict. */
  time: number | null;
}

/** One enemy spawn's post-mirror distance to the nearest ally spawn. */
export interface SpawnMatch {
  /** The enemy spawn's entity id. */
  entityId: number;
  /** Nearest ally-spawn distance after mirroring, in METRES. */
  distance: number;
}

/** Why the verdict came out the way it did. */
export type SpawnSymmetryReason =
  | "no-spawns"
  | "insufficient-data"
  | "symmetric"
  | "asymmetric"
  | "ambiguous";

export interface SpawnSymmetryResult {
  /** true = mirrored fleet shape; false = clearly one-sided enemy spawns
   *  (only this verdict may PROMOTE a plain co-op label to operation);
   *  null = no verdict (leave classification untouched). */
  symmetric: boolean | null;
  allySpawns: SpawnPoint[];
  enemySpawns: SpawnPoint[];
  /** Matched enemy spawns / enemy spawns (0..1); null when one side has no
   *  usable spawn (the symmetry centre cannot be estimated). */
  matchFraction: number | null;
  /** Effective mirror tolerance in METRES. */
  tolerance: number;
  /** Estimated central-symmetry centre, in replay world units; null when a
   *  side is empty. Diagnostics/tests only. */
  centre: { x: number; z: number } | null;
  /** Per-enemy nearest-ally distances after mirroring (metres). Diagnostics
   *  and tests — the verdict only reads matchFraction. */
  matches: SpawnMatch[];
  reason: SpawnSymmetryReason;
}

export interface SpawnSymmetryOptions {
  /** Absolute mirror tolerance in METRES. When omitted the default floor
   *  (DEFAULT_SPAWN_TOLERANCE_M) grows with the mean cluster radius. */
  tolerance?: number;
  /** Minimum usable spawns per side for a verdict (default 2). */
  minSpawnsPerSide?: number;
  /** matchFraction >= this => symmetric (default 0.6). */
  symmetricAt?: number;
  /** matchFraction <= this => asymmetric (default 0.5). */
  asymmetricAt?: number;
}

/** Spawn point of one trajectory: the EntityCreate's initial position when
 *  finite, else the first position sample. Null when neither is usable. */
function spawnPointOf(traj: EntityTrajectory): SpawnPoint | null {
  const kind = traj.kind;
  let x = kind?.initialX;
  let z = kind?.initialZ;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    const first = traj.samples?.[0];
    if (!first || !Number.isFinite(first.x) || !Number.isFinite(first.z)) {
      return null;
    }
    x = first.x;
    z = first.z;
  }
  const created = kind?.creationTime;
  const firstTime = traj.samples?.[0]?.time;
  const time = Number.isFinite(created)
    ? (created as number)
    : Number.isFinite(firstTime)
      ? (firstTime as number)
      : null;
  // TypeScript cannot narrow the optional-number checks above; the runtime
  // values are finite here.
  return { entityId: traj.entityId, x: x as number, z: z as number, time };
}

/** Planar distance between two world-space points (world units). */
function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Mean distance of the points from their centroid (world units). */
function meanClusterRadius(points: readonly { x: number; z: number }[], centroid: { x: number; z: number }): number {
  let sum = 0;
  for (const point of points) sum += distance(point, centroid);
  return sum / points.length;
}

/**
 * Probe whether the two sides' spawn clouds are centrally (180°) symmetric —
 * the weak decode-time 行动 (operation) supplemental signal.
 *
 * `sideOf` resolves each entity's battle side; entities it returns `null`
 * for (capture zones, unknown ents) are skipped. Spawn points come from
 * `kind.initialX/initialZ` (the EntityCreate position), falling back to the
 * first trajectory sample; entities with neither are skipped.
 *
 * Read the module doc for the model, heuristic thresholds and limitations.
 */
export function analyzeSpawnSymmetry(
  trajectories: readonly EntityTrajectory[],
  sideOf: (entityId: number) => EntitySide | null,
  options: SpawnSymmetryOptions = {},
): SpawnSymmetryResult {
  const allySpawns: SpawnPoint[] = [];
  const enemySpawns: SpawnPoint[] = [];
  for (const traj of trajectories) {
    const side = sideOf(traj.entityId);
    if (side === null) continue;
    const spawn = spawnPointOf(traj);
    if (!spawn) continue;
    (side === "ally" ? allySpawns : enemySpawns).push(spawn);
  }

  const minSpawnsPerSide = Math.max(1, options.minSpawnsPerSide ?? MIN_SPAWNS_PER_SIDE);
  const symmetricAt = options.symmetricAt ?? DEFAULT_SYMMETRIC_AT;
  const asymmetricAt = options.asymmetricAt ?? DEFAULT_ASYMMETRIC_AT;

  const empty = (reason: SpawnSymmetryReason): SpawnSymmetryResult => ({
    symmetric: null,
    allySpawns,
    enemySpawns,
    matchFraction: null,
    tolerance: options.tolerance ?? DEFAULT_SPAWN_TOLERANCE_M,
    centre: null,
    matches: [],
    reason,
  });

  if (allySpawns.length === 0 || enemySpawns.length === 0) {
    return empty("no-spawns");
  }

  // Centroid of each side, and the symmetry centre as their midpoint. Under
  // central symmetry the two centroids are each other's mirror, so their
  // midpoint IS the symmetry centre — no map data needed.
  const centroidOf = (points: readonly SpawnPoint[]) => {
    let x = 0;
    let z = 0;
    for (const point of points) {
      x += point.x;
      z += point.z;
    }
    return { x: x / points.length, z: z / points.length };
  };
  const allyCentroid = centroidOf(allySpawns);
  const enemyCentroid = centroidOf(enemySpawns);
  const centre = {
    x: (allyCentroid.x + enemyCentroid.x) / 2,
    z: (allyCentroid.z + enemyCentroid.z) / 2,
  };

  // Tolerance: explicit override wins; otherwise the default floor grows
  // with the mean cluster radius (world units -> metres).
  const meanRadius = (meanClusterRadius(allySpawns, allyCentroid) + meanClusterRadius(enemySpawns, enemyCentroid)) / 2;
  const tolerance = options.tolerance
    ?? Math.max(
      DEFAULT_SPAWN_TOLERANCE_M,
      CLUSTER_RADIUS_TOLERANCE_FRACTION * meanRadius * WORLD_UNIT_METERS,
    );
  const toleranceWorldUnits = tolerance / WORLD_UNIT_METERS;

  const matches: SpawnMatch[] = [];
  let matched = 0;
  for (const enemy of enemySpawns) {
    let nearest = Number.POSITIVE_INFINITY;
    const mirrored = { x: 2 * centre.x - enemy.x, z: 2 * centre.z - enemy.z };
    for (const ally of allySpawns) {
      const d = distance(mirrored, ally);
      if (d < nearest) nearest = d;
    }
    matches.push({ entityId: enemy.entityId, distance: nearest * WORLD_UNIT_METERS });
    if (nearest <= toleranceWorldUnits) matched += 1;
  }
  const matchFraction = matched / enemySpawns.length;

  let symmetric: boolean | null;
  let reason: SpawnSymmetryReason;
  if (allySpawns.length < minSpawnsPerSide || enemySpawns.length < minSpawnsPerSide) {
    symmetric = null;
    reason = "insufficient-data";
  } else if (matchFraction >= symmetricAt) {
    symmetric = true;
    reason = "symmetric";
  } else if (matchFraction <= asymmetricAt) {
    symmetric = false;
    reason = "asymmetric";
  } else {
    symmetric = null;
    reason = "ambiguous";
  }

  return {
    symmetric,
    allySpawns,
    enemySpawns,
    matchFraction,
    tolerance,
    centre,
    matches,
    reason,
  };
}
