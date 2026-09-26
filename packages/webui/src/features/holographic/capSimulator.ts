/**
 * Capture-point ownership + domination score simulation, extracted verbatim
 * from HolographicMap.tsx. Fully derived from the replay stream (capSamples
 * ownership changes, ship positions, HP streams) so scrubbing reproduces the
 * same result; the per-zone simulator state (`capSim`) lives on the shared
 * map context.
 */
import { KILL_PTS, SPECIAL_CAP_MAPS, type CapZoneState } from "./capZones";
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
    const traj = ctx.props.trajectories.find((tr) => tr.entityId === m.userData.entityId);
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

/** Advance a zone's capture simulation from lastSimT to t in 0.5s steps.
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
  const step = 0.5;
  while (simT < t) {
    const nxt = Math.min(simT + step, t);
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
      const traj = ctx.props.trajectories.find((tr) => tr.entityId === m.userData.entityId);
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
    const contested = ally > 0 && enemy > 0;
    if (st.owner === 0) {
      // Neutral: a single team present starts capturing it.
      if ((ally > 0) !== (enemy > 0)) {
        st.progress += step / (Math.max(ally, enemy) >= 2 ? 40 : 60);
        if (st.progress > 1) st.progress = 1;
      }
    } else if (!contested && enemy > 0 && ally === 0 && st.owner === 1) {
      // Enemy-only inside an allied point: re-capturing (ring visual;
      // the actual flip comes from the prop0 stream).
      st.progress += step / (enemy >= 2 ? 40 : 60);
      if (st.progress > 1) st.progress = 1;
    } else if (!contested && ally > 0 && enemy === 0 && st.owner === 2) {
      // Allied-only inside an enemy point: re-capturing it the same way.
      st.progress += step / (ally >= 2 ? 40 : 60);
      if (st.progress > 1) st.progress = 1;
    } else {
      // Owner keeps scoring accrual while NOT contested — including
      // with the owner's own ships sitting on the point (the standard
      // 2-cap opening: both home points tick from second one, with the
      // whole home fleet inside). In-game this is the passive 3 pts
      // per 2 s per owned point.
      if (accrualEvery > 0 && !contested) {
        st.accrualT += step;
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

/** Owner at time t from the raw capSamples stream; before the first
 *  ownership sample (or with no stream at all) fall back to the zone's
 *  initial team from the create state — zones captured from match start
 *  never emit ownership updates. teamId is a 0/1 SIDE number, so it maps
 *  to the owner code (1 = recorder's side) via the recorder's own team
 *  from the post-battle payload. */
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

/** Recompute cap zone states + score at playback time t. Fully derived
 *  from the replay stream (capSamples ownership changes, ship positions,
 *  HP streams) so scrubbing reproduces the same result. */
export function updateCapsAndScore(ctx: MapInternals, t: number) {
  const zones = ctx.capZones.value;
  const scoring = ctx.scoringZones.value;
  // Scoring parameters by mode + map (based on REAL capture points).
  const isRanked = ctx.props.matchGroup === "ranked" || ctx.props.matchGroup === "clan";
  const special = SPECIAL_CAP_MAPS.has(ctx.props.mapName);
  const nAreas = scoring.length;
  const startPts = special ? 150 : isRanked ? 300 : nAreas >= 4 ? 200 : 300;
  const capCompletePts = special ? 40 : isRanked ? (nAreas >= 4 ? 2 : 9) : nAreas >= 4 ? 4 : 3;
  // Accrual: (every N seconds, +P per controlled area). Randoms 2-3
  // points = 3 pts / 6 s — SOLVED from the real Canada domination_2point
  // replay: final 843 = 300 start + 135 kill points (4 enemy sinks:
  // CA+SS+CA+BB) + rate × 818 owned-cap-seconds (home point contested
  // t=311..377) → rate = 0.499 pts/s. 4+ points keep 4/9 s.
  let accrualEvery = 0;
  let accrualPts = 0;
  if (!special) {
    if (isRanked) {
      accrualEvery = nAreas >= 4 ? 0 : nAreas === 2 ? 10 : 3;
      accrualPts = nAreas >= 4 ? 0 : nAreas === 2 ? 9 : 2;
    } else {
      accrualEvery = nAreas >= 4 ? 9 : 6;
      accrualPts = nAreas >= 4 ? 4 : 3;
    }
  }

  let allyScoreNow = startPts;
  let enemyScoreNow = startPts;

  // Kill / death points by ship class (classic tables; special maps
  // override with flat +40/-25).
  for (const m of ctx.shipMarkers) {
    const dt = m.userData.deathTime as number | null;
    if (dt == null || t < dt) continue;
    const role = m.userData.role as TeamRole;
    const killer = role === "ally" || role === "self" ? "enemy" : "ally";
    const type = (m.userData.type as string | undefined) ?? "";
    // Both branches below assign before any read — no initializer.
    let kill: number;
    let death: number;
    if (special) {
      kill = 40;
      death = -25;
    } else {
      const cls =
        type.includes("Destroyer") ? "Destroyer"
        : type.includes("Battleship") ? "Battleship"
        : type.includes("AirCarrier") || type.includes("AirCar") ? "AirCarrier"
        : type.includes("Submarine") ? "Submarine"
        : "Cruiser";
      kill = KILL_PTS[cls].kill;
      death = KILL_PTS[cls].death;
    }
    if (killer === "ally") allyScoreNow += kill;
    else enemyScoreNow += kill;
    if (role === "ally" || role === "self") allyScoreNow += death;
    else enemyScoreNow += death;
  }

  // Cap completion + accrual come from the per-zone simulation (which
  // pauses accrual while a point is contested), plus per-zone live capture
  // state for the UI.
  const display: CapZoneState[] = [];
  const scoringSet = new Set(scoring.map((z) => z.entityId));
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const eid = zone.entityId;
    const samples = (zone.capSamples ?? []).map((s) => ({ time: s.time, value: s.value }));
    if (!scoringSet.has(eid)) {
      // Strike/event zone: rendered, never scored, no capture sim.
      const { ally, enemy } = shipsInZone(ctx, zone, t);
      display.push({
        letter: String.fromCharCode(65 + i),
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
    let st = ctx.capSim.get(eid);
    if (!st || st.lastT > t) {
      st = {
        lastT: 0,
        progress: 0,
        owner: ownerAt(ctx, samples, 0, zone.kind?.initialTeam ?? null),
        prevHp: new Map(),
        accrualT: 0,
        scoreAlly: 0,
        scoreEnemy: 0,
      };
      ctx.capSim.set(eid, st);
    }
    simulateZone(ctx, zone, eid, t, samples, capCompletePts, accrualEvery, accrualPts);
    allyScoreNow += st.scoreAlly;
    enemyScoreNow += st.scoreEnemy;
    const { ally, enemy } = shipsInZone(ctx, zone, t);
    // Capturing requires someone INSIDE the point — a neutral point with
    // leftover progress (capture started, then everyone left) must not
    // keep its diamond + ring spinning forever.
    const capturing =
      st.progress > 0.001 && st.progress < 1 && ally + enemy > 0;
    display.push({
      letter: String.fromCharCode(65 + i),
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
  ctx.capDisplay.value = display;
  // Standard battles end at 1000 points — clamp both scores so the
  // reconstructed total can never exceed the real win condition.
  ctx.allyScore.value = Math.min(allyScoreNow, 1000);
  ctx.enemyScore.value = Math.min(enemyScoreNow, 1000);
}
