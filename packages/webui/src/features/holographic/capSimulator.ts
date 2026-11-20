/**
 * Capture-point ownership + domination score simulation, extracted verbatim
 * from HolographicMap.tsx. Fully derived from the replay stream (capSamples
 * ownership changes, ship positions, HP streams) so scrubbing reproduces the
 * same result; the per-zone simulator state (`capSim`) lives on the shared
 * map context.
 */
import {
  KILL_PTS,
  SPECIAL_CAP_MAPS,
  capLetter,
  zoneIsLive,
  zoneNeedsEngagement,
  type CapZoneState,
} from "./capZones";
import { sampleAt, hpAtTime, progressAtTime } from "./trajectoryMath";
import type { EntityTrajectory } from "@/api";
import type { TeamRole } from "./teamColors";
import type { MapInternals } from "./mapInternals";

/** Ships inside a capture point at time t (within the zone radius) with
 *  their HP snapshots for hit-rollback detection. */
function shipsInZone(ctx: MapInternals, zone: EntityTrajectory, t: number): { ally: number; enemy: number } {
  const cx = zone.kind!.initialX;
  const cz = zone.kind!.initialZ;
  const R = zone.kind!.radius ?? 60; // recovered from the EntityCreate state
  let ally = 0;
  let enemy = 0;
  for (const m of ctx.shipMarkers) {
    const traj = ctx.trajById.get(m.userData.entityId as number);
    if (!traj || traj.samples.length === 0) continue;
    const s = sampleAt(traj, t);
    if (!s) continue;
    const d = (s.x - cx) ** 2 + (s.z - cz) ** 2;
    if (d > R * R) continue;
    const role = m.userData.role as TeamRole;
    if (role === "ally" || role === "self") ally++;
    else if (role === "enemy") enemy++;
  }
  return { ally, enemy };
}

/** Advance a zone's capture simulation from lastSimT to t, sampling ships
 *  in at most 0.5 s slices but charging each slice's REAL elapsed time.
 *  Ownership always follows the recorded prop0 stream; the simulation
 *  drives the visible progress ring (speed by ships inside, frozen when
 *  contested, halved when an inside ship takes a hit) AND the point's
 *  score: +capComplete on every ownership change (except a pre-placed
 *  starting zone), plus accrual points only while the point is controlled
 *  with no enemy ship inside (the game pauses accrual while contested). */
function simulateZone(ctx: MapInternals,
  zone: EntityTrajectory,
  eid: number,
  t: number,
  samples: { time: number; value: number }[],
  capCompletePts: number,
  accrualEvery: number,
  accrualPts: number,
) {
  const st = ctx.capSim.get(eid);
  if (!st) return;
  // The game's own progress stream (0x23) beats position simulation.
  const realProgress =
    zone.capProgress != null && zone.capProgress.length >= 2;
  let simT = st.lastT;
  // Ownership changes are applied step-by-step as the sim crosses their
  // timestamps (applying them up front would give the owner early
  // accrual for the whole [0, changeTime) stretch).
  let si = 0;
  while (si < samples.length && samples[si].time <= simT) si++;
  // Maximum SIMULATION granularity (how often ships/HP are re-sampled), NOT
  // the time actually elapsed: during playback updateCapsAndScore runs once
  // per rendered frame, so a 60 fps tick is ~0.017 s. Charging the whole 0.5 s
  // step to the accrual clock (and to the capture progress) made the sim
  // advance ~30x faster than the replay at 1x speed — three owned points
  // raced the 1000 clamp within ~25 s of playback. Every time-dependent
  // quantity below uses `dt` (the real slice) so the result depends only on
  // the playhead, never on the frame rate or the number of calls.
  const step = 0.5;
  while (simT < t) {
    const nxt = Math.min(simT + step, t);
    const dt = nxt - simT;
    const mid = (simT + nxt) / 2;
    while (si < samples.length && samples[si].time < nxt) {
      const s = samples[si];
      if (s.time > simT) {
        const changed = s.value !== st.owner;
        st.owner = s.value;
        st.progress = 0;
        st.prevHp = new Map();
        st.accrualT = 0;
        // A completed capture (any non-neutral change) scores
        // +capComplete; a starting zone placed at battle start (first
        // sample, t < 5) is not a capture event.
        if (changed && s.value !== 0 && s.time > 5) {
          if (s.value === 1) st.scoreAlly += capCompletePts;
          else st.scoreEnemy += capCompletePts;
        }
      }
      si++;
    }
    const cx = zone.kind!.initialX;
    const cz = zone.kind!.initialZ;
    const R = zone.kind!.radius ?? 60;
    let ally = 0;
    let enemy = 0;
    for (const m of ctx.shipMarkers) {
      const traj = ctx.trajById.get(m.userData.entityId as number);
      if (!traj || traj.samples.length === 0) continue;
      const s = sampleAt(traj, mid);
      if (!s) continue;
      if ((s.x - cx) ** 2 + (s.z - cz) ** 2 > R * R) continue;
      const role = m.userData.role as TeamRole;
      if (role === "ally" || role === "self") ally++;
      else if (role === "enemy") enemy++;
      // Hit rollback: HP dropped inside the zone → progress halves.
      if (traj.hpSamples && traj.hpSamples.length > 0) {
        const hp = hpAtTime(traj.hpSamples, mid);
        const prev = st.prevHp.get(traj.entityId) ?? hp;
        if (prev != null && hp != null && hp < prev - 50) {
          st.progress *= 0.5;
        }
        const hpVal = hp ?? prev;
        if (hpVal != null) st.prevHp.set(traj.entityId, hpVal);
      }
    }
    // Operation story objectives reveal on first physical entry — latch the
    // instant (see zoneNeedsEngagement; the walk always starts at the zone's
    // birth, so a forward scrub re-derives the same latch).
    if (ally + enemy > 0 && st.revealAt == null) {
      st.revealAt = mid;
    }
    const contested = ally > 0 && enemy > 0;
    if (st.owner === 0) {
      // Neutral: a single team present starts capturing it.
      if ((ally > 0) !== (enemy > 0)) {
        st.progress += dt / (Math.max(ally, enemy) >= 2 ? 40 : 60);
        if (st.progress > 1) st.progress = 1;
      }
    } else if (!contested && enemy > 0 && ally === 0 && st.owner === 1) {
      // Enemy-only inside an allied point: re-capturing (ring visual;
      // the actual flip comes from the prop0 stream).
      st.progress += dt / (enemy >= 2 ? 40 : 60);
      if (st.progress > 1) st.progress = 1;
    } else if (!contested && ally > 0 && enemy === 0 && st.owner === 2) {
      // Allied-only inside an enemy point: re-capturing it the same way.
      st.progress += dt / (ally >= 2 ? 40 : 60);
      if (st.progress > 1) st.progress = 1;
    } else {
      // Owner keeps scoring accrual while NOT contested — including
      // with the owner's own ships sitting on the point (the standard
      // 2-cap opening: both home points tick from second one, with the
      // whole home fleet inside). In-game this is the passive interval
      // from the scoring table (accrualPts every accrualEvery seconds).
      if (accrualEvery > 0 && !contested) {
        st.accrualT += dt;
        while (st.accrualT >= accrualEvery) {
          st.accrualT -= accrualEvery;
          if (st.owner === 1) st.scoreAlly += accrualPts;
          else st.scoreEnemy += accrualPts;
        }
      }
    }
    // Override the simulated progress with the game's own stream when the
    // replay carries it (NestedPropertyUpdate 0x23): far more accurate
    // than inferring from ship positions.
    if (realProgress) {
      const cp = progressAtTime(zone.capProgress, nxt);
      if (cp != null) {
        st.progress = Math.min(1, cp / 1000);
        st.prevHp.clear();
      }
    }
    simT = nxt;
  }
  st.lastT = t;
}

/** The dormant placeholder pushed for hidden zones (unborn, unrevealed or
 *  resolved): every surface renders `live: false` as fully absent. */
function dormantCap(letter: string): CapZoneState {
  return {
    letter,
    live: false,
    owner: 0,
    progress: 0,
    alliesIn: 0,
    enemiesIn: 0,
    contested: false,
    capturing: false,
    speed: 1 / 60,
    etaSeconds: null,
    captureTeam: 0,
  };
}

/** Owner at time t from the raw capSamples stream; before the first
 *  ownership sample (or with no stream at all) fall back to the zone's
 *  initial team from the create state — zones captured from match start
 *  never emit ownership updates. teamId is a 0/1 SIDE number, so it maps
 *  to the owner code (1 = recorder's side) via the recorder's own team
 *  from the post-battle payload. Operations pass null: their pre-placed
 *  zones carry the SCRIPT's owning team (e.g. every objective born
 *  team-1 in a story assault), which painted the whole board enemy-red
 *  from the first frame — in-story objectives start unclaimed until the
 *  game's own stream (or the capture sim) flips them. */
function ownerAt(ctx: MapInternals,
  samples: { time: number; value: number }[],
  t: number,
  initialTeam: number | null,
): number {
  let o = 0;
  let seen = false;
  for (const s of samples) {
    if (s.time <= t) {
      o = s.value;
      seen = true;
    } else break;
  }
  if (
    seen && o === 0 && samples.length === 1 &&
    initialTeam != null && initialTeam >= 0
  ) {
    seen = false; // cleanup flush only — keep the starting owner
  }
  if (!seen && initialTeam != null && initialTeam >= 0) {
    const st = ctx.selfTeam.value;
    o = st != null ? (initialTeam === st ? 1 : 2) : 0;
  }
  return o;
}

/** A ship marker's scoring-relevant fields — the subset of the THREE
 *  marker's userData the kill/death attribution reads. */
export interface SunkShipMarker {
  role: TeamRole;
  type?: string;
  deathTime: number | null;
}

/** Scoring family a replay belongs to — the wiki's four columns
 *  (wiki.worldofwarships.com/Ship:Game_Modes "Points for destroying enemy
 *  ships"). Co-op shares the Random kill/death table; Ranked and Clan
 *  battles use a flat +40/-60 (+60/-90 for carriers) instead of the
 *  per-class Random table. */
export type ScoringMode = "random" | "coop" | "ranked" | "clan";

/** Kill/death points the sunk ships add to each side's score by time `t`
 * (classic class tables; `special` maps override with flat +40/-25, and
 * ranked/clan battles with the flat ranked table). Team modes attribute
 * each sink's kill points to the OPPOSITE side, inferred from the marker's
 * role. Operation scenarios (行动) make NO attribution: their single-team
 * roster cannot tell an enemy bot from an ally script ship (relation
 * follows scenario slots — see #606), so crediting the enemy score from
 * friendly sinks would be pure invention; only the cap simulation (which
 * follows the game's own ownership stream) scores. */
export function sunkShipPoints(
  markers: SunkShipMarker[],
  t: number,
  special: boolean,
  operation = false,
  mode: ScoringMode = "random",
): { ally: number; enemy: number } {
  let ally = 0;
  let enemy = 0;
  if (operation) return { ally, enemy };
  for (const m of markers) {
    const dt = m.deathTime;
    if (dt == null || t < dt) continue;
    const killer = m.role === "ally" || m.role === "self" ? "enemy" : "ally";
    let kill: number;
    let death: number;
    if (special) {
      kill = 40;
      death = -25;
    } else {
      const cls =
        (m.type ?? "").includes("Destroyer") ? "Destroyer"
        : (m.type ?? "").includes("Battleship") ? "Battleship"
        : (m.type ?? "").includes("AirCarrier") || (m.type ?? "").includes("AirCar") ? "AirCarrier"
        : (m.type ?? "").includes("Submarine") ? "Submarine"
        : "Cruiser";
      if (mode === "ranked" || mode === "clan") {
        // Ranked / Clan: every class +40 / -60, carriers +60 / -90.
        const carrier = cls === "AirCarrier";
        kill = carrier ? 60 : 40;
        death = carrier ? -90 : -60;
      } else {
        kill = KILL_PTS[cls].kill;
        death = KILL_PTS[cls].death;
      }
    }
    if (killer === "ally") ally += kill;
    else enemy += kill;
    if (m.role === "ally" || m.role === "self") ally += death;
    else enemy += death;
  }
  return { ally, enemy };
}

/** Domination scoring parameters for one replay, from the official table
 *  (wiki.worldofwarships.com/Ship:Game_Modes → "Domination"):
 *
 *  |                  | start | capture | controlled area      |
 *  | Random 3 areas   |  300  |  +3     | +3 every 5 s           |
 *  | Random 4 areas   |  200  |  +4     | +4 every 9 s           |
 *  | Co-op 3 areas    |  400  |  +3     | +3 every 5 s           |
 *  | Co-op 4 areas    |  300  |  +4     | +4 every 9 s           |
 *  | Ranked 2 areas   |  300  |  +9     | +9 every 10 s          |
 *  | Ranked 3 areas   |  300  |  +2     | +2 every 3 s           |
 *  | Clan 3 areas     |  300  |  +3     | +3 every 4 s           |
 *
 *  The eight "special" maps (start 150, kills +40, deaths -25 — see
 *  SPECIAL_CAP_MAPS) change ONLY those three settings: the capture award
 *  and the per-area interval above still apply (this module used to award
 *  +40 per capture — the KILL value — and drop area accrual entirely).
 *
 *  Cadence note: the table says 5 s for 3 areas, but a full solve of the
 *  real Canada domination_2point replay (final 843 = 300 start + 135 kill
 *  points + 136 windows x 3 over 818 owned-cap-seconds, contested
 *  t=311..377) pins the shipped rate at 3 pts / 6 s. The replay-derived
 *  number wins here; 5 s would inflate every score by 20%. A second replay
 *  with a known final score would settle it.
 *
 *  `nAreas` is the count of REAL capture points in the replay (the create
 *  state's controlPoint component), not the map's nominal layout. */
export function scoringRules(
  props: { matchGroup?: string | null; mapName?: string | null; operation?: boolean },
  nAreas: number,
): {
  mode: ScoringMode;
  special: boolean;
  startPts: number;
  capCompletePts: number;
  /** Seconds between two area-accrual ticks; 0 = this mode has none. */
  accrualEvery: number;
  accrualPts: number;
} {
  const fourArea = nAreas >= 4;
  const special = SPECIAL_CAP_MAPS.has(props.mapName ?? "");
  const group = props.matchGroup ?? "";
  const isRanked = group === "ranked";
  const isClan = group === "clan";
  // Co-op is the "pve" matchGroup WITHOUT a story operation: operations hide
  // the score digits entirely, and their pre-placed objectives are not
  // scored by the domination rules at all.
  const isCoop = group === "pve" && !props.operation;
  const mode: ScoringMode = isRanked
    ? "ranked"
    : isClan
      ? "clan"
      : isCoop
        ? "coop"
        : "random";
  const startPts = special
    ? 150
    : isRanked || isClan
      ? 300
      : isCoop
        ? fourArea
          ? 300
          : 400
        : fourArea
          ? 200
          : 300;
  const capCompletePts = special
    ? fourArea
      ? 4
      : 3
    : isRanked
      ? nAreas <= 2
        ? 9
        : 2
      : isClan
        ? 3
        : fourArea
          ? 4
          : 3;
  let accrualEvery = 0;
  let accrualPts = 0;
  if (isRanked) {
    if (nAreas <= 2) {
      accrualEvery = 10;
      accrualPts = 9;
    } else if (!fourArea) {
      accrualEvery = 3;
      accrualPts = 2;
    }
    // Ranked 4-area: the table has no such mode (N/A) → no area accrual.
  } else if (isClan) {
    // Clan (and any 2-area clan exception): the table only lists 3 areas.
    accrualEvery = 4;
    accrualPts = 3;
  } else {
    // Random, co-op and the eight special maps share the interval table.
    accrualEvery = fourArea ? 9 : 6;
    accrualPts = fourArea ? 4 : 3;
  }
  return { mode, special, startPts, capCompletePts, accrualEvery, accrualPts };
}

/** Recompute cap zone states + score at playback time t. Fully derived
 *  from the replay stream (capSamples ownership changes, ship positions,
 *  HP streams) so scrubbing reproduces the same result. */
export function updateCapsAndScore(ctx: MapInternals, t: number) {
  const zones = ctx.capZones.value;
  const scoring = ctx.scoringZones.value;
  // Scoring parameters by mode + map (based on REAL capture points).
  const rules = scoringRules(ctx.props, scoring.length);
  const { special, startPts, capCompletePts, accrualEvery, accrualPts } = rules;

  let allyScoreNow = startPts;
  let enemyScoreNow = startPts;

  // Kill / death points by ship class (classic tables; special maps
  // override with flat +40/-25). Operations make no attribution — see
  // sunkShipPoints.
  const sunkPts = sunkShipPoints(
    ctx.shipMarkers.map((m) => ({
      role: m.userData.role as TeamRole,
      type: m.userData.type as string | undefined,
      deathTime: m.userData.deathTime as number | null,
    })),
    t,
    special,
    ctx.props.operation,
    rules.mode,
  );
  allyScoreNow += sunkPts.ally;
  enemyScoreNow += sunkPts.enemy;

  // Cap completion + accrual come from the per-zone simulation (which
  // pauses accrual while a point is contested), plus per-zone live capture
  // state for the UI.
  const display: CapZoneState[] = [];
  const scoringSet = new Set(scoring.map((z) => z.entityId));
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const eid = zone.entityId;
    const samples = (zone.capSamples ?? []).map((s) => ({ time: s.time, value: s.value }));
    // Operation points are CREATED mid-battle (EntityCreate time): until
    // the playhead crosses that instant the zone does not exist yet — no
    // ring, no letter, no chip, no simulation, no score. Pre-recording
    // zones (PvP domination) are born before t=0 and never hit this.
    if (!zoneIsLive(zone, t)) {
      display.push(dormantCap(capLetter(zone, i)));
      continue;
    }
    if (!scoringSet.has(eid)) {
      // Strike/event zone: rendered, never scored, no capture sim.
      const { ally, enemy } = shipsInZone(ctx, zone, t);
      display.push({
        letter: capLetter(zone, i),
        live: true,
        owner: 0,
        progress: 0,
        alliesIn: ally,
        enemiesIn: enemy,
        contested: false,
        capturing: false,
        speed: 1 / 60,
        etaSeconds: null,
        captureTeam: 0,
      });
      continue;
    }
    // Capture simulation: replay from scratch on scrub-back, else advance.
    // The sim clock starts at the zone's OWN birth time — a point created
    // mid-battle must not accrue owner points for the stretch before it
    // existed (scrubbing below the birth time hits the reset branch above
    // and the dormant entry instead).
    const simStart = Math.max(0, zone.kind?.creationTime ?? 0);
    let st = ctx.capSim.get(eid);
    if (!st || st.lastT > t) {
      st = {
        lastT: simStart,
        progress: 0,
        owner: ownerAt(
          ctx,
          samples,
          0,
          // Operations never inherit the script's owning team — see ownerAt.
          ctx.props.operation ? null : zone.kind?.initialTeam ?? null,
        ),
        prevHp: new Map(),
        accrualT: 0,
        scoreAlly: 0,
        scoreEnemy: 0,
        revealAt: null,
      };
      ctx.capSim.set(eid, st);
    }
    simulateZone(ctx, zone, eid, t, samples, capCompletePts, accrualEvery, accrualPts);
    allyScoreNow += st.scoreAlly;
    enemyScoreNow += st.scoreEnemy;
    // Operation story objectives (行动剧情) leave the board twice: before
    // the script activates them — a pre-placed point (born at t=0) has no
    // activation signal in the replay, so it stays hidden until a ship
    // first sails into its radius (zoneNeedsEngagement) — and once the
    // objective RESOLVES, i.e. its capture completes (the sim crossing
    // progress 1, or the game's own ownership stream flipping the point):
    // a captured/lost story objective disappears instead of lingering to
    // the end screen. PvP domination keeps points pinned; the operation
    // flag is single-team-only, so co-op domination is untouched too.
    if (ctx.props.operation) {
      const unrevealed =
        zoneNeedsEngagement(zone) &&
        (st.revealAt == null || t < st.revealAt);
      const resolved = st.progress >= 1 || st.owner !== 0;
      if (unrevealed || resolved) {
        display.push(dormantCap(capLetter(zone, i)));
        continue;
      }
    }
    const { ally, enemy } = shipsInZone(ctx, zone, t);
    // Capturing requires someone INSIDE the point — a neutral point with
    // leftover progress (capture started, then everyone left) must not
    // keep its diamond + ring spinning forever.
    const capturing =
      st.progress > 0.001 && st.progress < 1 && ally + enemy > 0;
    display.push({
      letter: capLetter(zone, i),
      live: true,
      owner: st.owner,
      progress: st.progress,
      alliesIn: ally,
      enemiesIn: enemy,
      contested: ally > 0 && enemy > 0,
      capturing,
      speed: 1 / (Math.max(ally, enemy) >= 2 ? 40 : 60),
      // ETA to finish if the situation holds (null when paused/not
      // capturing); the 0x23 progress stream drives st.progress so
      // remaining-fraction / tick-rate matches the visible ring.
      etaSeconds:
        capturing && !(ally > 0 && enemy > 0)
          ? (1 - st.progress) / (1 / (Math.max(ally, enemy) >= 2 ? 40 : 60))
          : null,
      captureTeam:
        st.owner === 0
          ? ally > enemy
            ? 1
            : enemy > ally
              ? 2
              : 0
          : st.owner === 1
            ? enemy > 0 && ally === 0
              ? 2
              : 0
            : ally > 0 && enemy === 0
              ? 1
              : 0,
    });
  }
  // Publish only when something visibly changed: the scorebar's computed
  // state maps this array, and re-assigning an identical-but-new array per
  // frame used to invalidate it on every rendered frame. The cap-ring
  // painters below markerUpdate read the LIVE simulation values (st), so
  // they keep their per-frame cadence regardless.
  let sig = "";
  for (const d of display) {
    sig += d.letter + ":" + (d.live ? "L" : "x") + ":" + d.owner + ":" + d.progress.toFixed(2) + ":" + d.alliesIn + ":" + d.enemiesIn + ":" + (d.contested ? "c" : "") + (d.capturing ? "t" : "") + ":" + d.etaSeconds + ":" + d.captureTeam + ";";
  }
  if (sig !== ctx._capDisplaySig) {
    ctx._capDisplaySig = sig;
    ctx.capDisplay.value = display;
  }
  // Standard battles end at 1000 points — clamp both scores so the
  // reconstructed total can never exceed the real win condition.
  ctx.allyScore.value = Math.min(allyScoreNow, 1000);
  ctx.enemyScore.value = Math.min(enemyScoreNow, 1000);
}
