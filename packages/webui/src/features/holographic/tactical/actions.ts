/**
 * Ship-action extraction for the tactical timeline. Turns the decoded replay
 * stream (trajectories, shell/torpedo launches, squadron markers, explosions)
 * into a flat, time-sorted list of per-ship actions that the timeline renders
 * as markers. Pure data-in/data-out — no Vue, no DOM — so the heuristics are
 * unit-testable.
 *
 * Everything here is best-effort: shell/torpedo/explosion streams only carry
 * what the recorder's avatar observed, and speed changes are inferred from
 * trajectory geometry (adaptive per-ship thresholds, no absolute unit
 * assumptions).
 */
import type {
  EntityTrajectory,
  ExplosionEvent,
  MinimapSquadronAdd,
  MinimapSquadronMove,
  MinimapSquadronRemove,
  ShellLaunchEvent,
  TorpedoLaunch,
} from "@/api/client";
import { planeRoleOf, shellAmmoOf } from "./shellTypes";

export type ShipActionKind =
  | "speedUp"
  | "speedDown"
  | "stop"
  | "shell"
  | "torpedo"
  | "planeTakeoff"
  | "planeDrop";

export interface ShipAction {
  id: string;
  /** Battle seconds. */
  time: number;
  /** Ship entity (or squadron owner) — joins EntityTrajectory.entityId. */
  entityId: number;
  kind: ShipActionKind;
  /** Shell family for "shell" / bomb family for "planeDrop" (HE/AP/SAP…). */
  ammo?: string;
  /** Squadron behavioural family for plane actions (fighter/dive/torpedo…). */
  planeRole?: string;
  /** Payload of a plane attack run. */
  dropKind?: "torpedo" | "bomb";
}

/** The slice of ReplayStream the extractor needs (structural, testable). */
export interface ActionSource {
  trajectories: EntityTrajectory[];
  shellLaunches?: ShellLaunchEvent[];
  torpedoes?: TorpedoLaunch[];
  explosions?: ExplosionEvent[];
  minimapSquadronAdds?: MinimapSquadronAdd[];
  minimapSquadronMoves?: MinimapSquadronMove[];
  minimapSquadronRemoves?: MinimapSquadronRemove[];
}

/** Ship-trajectory samples below this count carry no usable speed story. */
const MIN_SAMPLES = 30;
/** One speed event of a kind per ship within this window is merged away. */
const SPEED_DEBOUNCE_S = 12;
/** Same-kind plane attacks within this window collapse into one marker. */
const DROP_DEBOUNCE_S = 8;
/** Launch bursts within this window count as one salvo. */
const SALVO_WINDOW_S = 2;
/** An explosion within this distance of a squadron track point is a drop. */
const DROP_RADIUS = 260;
/** Squadrons whose job is not attacking — their overflight marks no drops. */
const NON_ATTACK_ROLES = new Set(["fighter", "scout"]);

export function extractActions(src: ActionSource): ShipAction[] {
  const shipIds = new Set(
    src.trajectories.filter((t) => t.kind?.entityType === 2).map((t) => t.entityId),
  );
  const out: ShipAction[] = [];
  out.push(...speedActions(src.trajectories));
  out.push(...shellActions(src.shellLaunches ?? []));
  out.push(...torpedoActions(src.torpedoes ?? [], shipIds));
  out.push(...planeActions(src));
  out.sort((a, b) => a.time - b.time || a.kind.localeCompare(b.kind));
  for (let i = 0; i < out.length; i++) out[i].id = `act-${i}`;
  return out;
}

// ── Speed up / slow down / stop (trajectory geometry) ────────────────────

function speedActions(trajectories: EntityTrajectory[]): ShipAction[] {
  const out: ShipAction[] = [];
  for (const traj of trajectories) {
    if (traj.kind?.entityType !== 2 || traj.samples.length < MIN_SAMPLES) continue;
    const death = traj.deathTime ?? Infinity;
    out.push(...shipSpeedEvents(traj, death));
  }
  return out;
}

function shipSpeedEvents(traj: EntityTrajectory, death: number): ShipAction[] {
  const s = traj.samples;
  const speeds: { t: number; v: number }[] = [];
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].time - s[i - 1].time;
    if (dt <= 0.2 || s[i].time > death) continue;
    const dd = Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z);
    speeds.push({ t: s[i].time, v: dd / dt });
  }
  if (speeds.length < MIN_SAMPLES / 2) return [];
  const sorted = [...speeds].map((q) => q.v).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 0;
  if (ref <= 0.01) return [];
  const stoppedV = Math.max(0.04, ref * 0.04);

  const out: ShipAction[] = [];
  let last: Record<"speedUp" | "speedDown" | "stop", number> = { speedUp: -1e9, speedDown: -1e9, stop: -1e9 };
  let stopped = speeds[0].v < stoppedV;
  const emit = (kind: "speedUp" | "speedDown" | "stop", t: number): void => {
    if (t - last[kind] < SPEED_DEBOUNCE_S || t < SPEED_DEBOUNCE_S) return;
    last[kind] = t;
    out.push({ id: "", time: t, entityId: traj.entityId, kind });
  };

  for (let i = 1; i < speeds.length; i++) {
    const { t, v } = speeds[i];
    if (!stopped && v < stoppedV) {
      stopped = true;
      emit("stop", t);
      continue;
    }
    if (stopped && v > ref * 0.2) {
      stopped = false;
      emit("speedUp", t);
      continue;
    }
    if (stopped) continue;
    // In motion: a ≥35 %-of-ref change across the neighbouring ±5 s window
    // with a consistent trend is a deliberate speed change.
    let lo = i;
    let hi = i;
    while (lo > 0 && t - speeds[lo - 1].t < 5) lo--;
    while (hi < speeds.length - 1 && speeds[hi + 1].t - t < 5) hi++;
    let wMin = Infinity;
    let wMax = -Infinity;
    for (let k = lo; k <= hi; k++) {
      if (speeds[k].v < wMin) wMin = speeds[k].v;
      if (speeds[k].v > wMax) wMax = speeds[k].v;
    }
    if (wMax - wMin < ref * 0.35) continue;
    const half = (lo + hi) / 2;
    const trendUp = i > half ? speeds[i].v > speeds[lo].v : speeds[i].v > speeds[hi].v;
    emit(trendUp ? "speedUp" : "speedDown", t);
  }
  return out;
}

// ── Gunfire (salvo-grouped shell launches) ───────────────────────────────

function shellActions(launches: ShellLaunchEvent[]): ShipAction[] {
  const out: ShipAction[] = [];
  // Group by owner; within an owner, bursts inside SALVO_WINDOW_S are one
  // action whose ammo is the burst's first resolvable shell family.
  let lastT = -1e9;
  let lastOwner = -1;
  let ammo: string | undefined;
  for (const e of launches) {
    if (e.ownerId === lastOwner && e.time - lastT <= SALVO_WINDOW_S) {
      if (ammo == null || ammo === "unknown") ammo = shellAmmoOf(e.paramsId).ammo;
      lastT = e.time;
      continue;
    }
    if (lastOwner >= 0 && ammo != null) {
      out.push({ id: "", time: lastT, entityId: lastOwner, kind: "shell", ammo });
    }
    lastOwner = e.ownerId;
    lastT = e.time;
    ammo = shellAmmoOf(e.paramsId).ammo;
  }
  if (lastOwner >= 0 && ammo != null) {
    out.push({ id: "", time: lastT, entityId: lastOwner, kind: "shell", ammo });
  }
  return out;
}

// ── Torpedoes (ship tubes vs air drops) ──────────────────────────────────

function torpedoActions(launches: TorpedoLaunch[], shipIds: Set<number>): ShipAction[] {
  const out: ShipAction[] = [];
  let lastT = -1e9;
  let lastOwner = -1;
  let air = false;
  const flush = (): void => {
    if (lastOwner < 0) return;
    if (air) {
      out.push({
        id: "",
        time: lastT,
        entityId: lastOwner,
        kind: "planeDrop",
        dropKind: "torpedo",
      });
    } else {
      out.push({ id: "", time: lastT, entityId: lastOwner, kind: "torpedo" });
    }
  };
  for (const e of launches) {
    const isShip = shipIds.has(e.ownerId);
    if (e.ownerId === lastOwner && e.time - lastT <= SALVO_WINDOW_S) {
      lastT = e.time;
      continue;
    }
    flush();
    lastOwner = e.ownerId;
    lastT = e.time;
    air = !isShip;
  }
  flush();
  return out;
}

// ── Squadrons: takeoffs + attack runs ────────────────────────────────────

interface SqTrack {
  ownerId: number;
  role: string;
  /** time-sorted (t, x, z) samples. */
  pts: { t: number; x: number; z: number }[];
  active: boolean;
  lastDrop: number;
}

function planeActions(src: ActionSource): ShipAction[] {
  const out: ShipAction[] = [];
  const squads = new Map<number, SqTrack>();
  const events: { t: number; fn: () => void }[] = [];

  const adds = [...(src.minimapSquadronAdds ?? [])].sort((a, b) => a.time - b.time);
  const removes = new Map<number, number[]>();
  for (const r of src.minimapSquadronRemoves ?? []) {
    (removes.get(r.planeId) ?? removes.set(r.planeId, []).get(r.planeId)!).push(r.time);
  }
  for (const add of adds) {
    events.push({
      t: add.time,
      fn: () => {
        let sq = squads.get(add.planeId);
        if (!sq) {
          sq = {
            ownerId: add.ownerId,
            role: planeRoleOf(add.paramsId),
            pts: [],
            active: false,
            lastDrop: -1e9,
          };
          squads.set(add.planeId, sq);
        }
        sq.pts.push({ t: add.time, x: add.x, z: add.z });
        if (sq.active) return; // marker refresh, not a new sortie
        sq.active = true;
        out.push({
          id: "",
          time: add.time,
          entityId: add.ownerId,
          kind: "planeTakeoff",
          planeRole: sq.role,
        });
      },
    });
  }
  for (const [planeId, times] of removes) {
    for (const t of times) {
      events.push({
        t,
        fn: () => {
          const sq = squads.get(planeId);
          if (sq) sq.active = false;
        },
      });
    }
  }

  // Explosions near an attacking squadron's track point = a bomb drop.
  const moves = [...(src.minimapSquadronMoves ?? [])].sort((a, b) => a.time - b.time);
  for (const m of moves) {
    events.push({
      t: m.time,
      fn: () => {
        const sq = squads.get(m.planeId);
        if (sq) sq.pts.push({ t: m.time, x: m.x, z: m.z });
      },
    });
  }
  events.sort((a, b) => a.t - b.t);

  // Feed timeline events in time order so activity state stays consistent.
  // An explosion is considered AFTER the events at its own time — the drop
  // must see the squadron's position at that very instant.
  const explosions = [...(src.explosions ?? [])].sort((a, b) => a.time - b.time);
  let ei = 0;
  const dropOwners = new Set<string>();
  for (const ex of explosions) {
    while (ei < events.length && events[ei].t <= ex.time) events[ei++].fn();
    considerExplosion(ex, squads, dropOwners, out);
  }
  for (; ei < events.length; ei++) events[ei].fn();
  return out;
}

function considerExplosion(
  ex: ExplosionEvent,
  squads: Map<number, SqTrack>,
  dropOwners: Set<string>,
  out: ShipAction[],
): void {
  const { ammo } = shellAmmoOf(ex.paramsId);
  if (ammo === "unknown") return; // unresolvable bursts add only noise
  for (const sq of squads.values()) {
    if (!sq.active || NON_ATTACK_ROLES.has(sq.role)) continue;
    if (Math.abs(ex.time - sq.lastDrop) < DROP_DEBOUNCE_S) continue;
    // nearest track point in time
    let best: { t: number; x: number; z: number } | null = null;
    for (const p of sq.pts) {
      if (best == null || Math.abs(p.t - ex.time) < Math.abs(best.t - ex.time)) best = p;
    }
    if (!best || Math.abs(best.t - ex.time) > 3) continue;
    if (Math.hypot(best.x - ex.x, best.z - ex.z) > DROP_RADIUS) continue;
    sq.lastDrop = ex.time;
    const key = `${sq.ownerId}@${Math.round(ex.time / DROP_DEBOUNCE_S)}`;
    if (dropOwners.has(key)) continue;
    dropOwners.add(key);
    out.push({
      id: "",
      time: ex.time,
      entityId: sq.ownerId,
      kind: "planeDrop",
      dropKind: "bomb",
      ammo,
      planeRole: sq.role,
    });
    return;
  }
}
