/**
 * Total / current HP resolution for replay playback, shared by every HP
 * surface (floating labels, self plaque, roster strip, hover tooltip,
 * camera menu, chat panel, status rows).
 *
 * The total (max) HP shown during playback must come from the ship's base
 * information, not from the HP packet stream: the stream only carries
 * readings while the ship was OBSERVED, so its peak is a damaged value for
 * enemies first spotted after taking hits, and event/asymmetric modes scale
 * it fractionally — both produce "totals" whose last digits are not 00.
 * The arena's initial state (`ArenaPlayer.maxHealth`, server-decoded at
 * match start) is the starting health of the exact build — upgrades and
 * mode scaling included — and is the authoritative source; the stream peak
 * remains only as the fallback for replays whose arena state did not decode.
 */
import type {
  ArenaPlayer,
  EntityTrajectory,
  HpSample,
  ShipInfo,
  VehicleEntry,
} from "@/api";
import type { PostBattleData } from "@/features/replay/postBattle";

/** Peak of the entity's HP packet stream. A LOWER BOUND of the true total:
 *  for enemies first observed after taking damage the peak is that damaged
 *  reading — only ever use as a fallback when no base-info source knows the
 *  ship (see `resolveMaxHp`). */
export function peakHpOf(samples: HpSample[] | undefined | null): number | null {
  if (!samples || samples.length === 0) return null;
  let m = samples[0].value;
  for (const s of samples) if (s.value > m) m = s.value;
  return m;
}

/** Stock hull HP from a WG encyclopedia entry (`defaultProfile.hull.health`)
 *  — the stock hull, not necessarily the player's fitted one. */
export function encyclopediaHullHealth(
  info: ShipInfo | null | undefined,
): number | null {
  const dp = info?.defaultProfile as
    | Record<string, Record<string, unknown>>
    | undefined;
  const h = dp?.hull?.health;
  return h != null && typeof h === "number" ? h : null;
}

/** Resolve a ship's total (max) HP. Priority: the arena's authoritative
 *  starting health of the exact build → the HP stream's peak (old replays
 *  without arena state; may under-report late-spotted enemies) → the
 *  encyclopedia stock hull → the offline GameParams hull HP. Every source
 *  rounds to a whole number so a fractional wire value can never leak into
 *  a display. Null when nothing knows the ship (the HP row then hides). */
export function resolveMaxHp(
  arenaMax: number | null | undefined,
  hpSamples: HpSample[] | undefined | null,
  encHealth: number | null,
  offlineHp: number | null,
): number | null {
  if (arenaMax != null && arenaMax > 0) return Math.round(arenaMax);
  const peak = peakHpOf(hpSamples);
  if (peak != null && peak > 0) return Math.round(peak);
  if (encHealth != null && encHealth > 0) return Math.round(encHealth);
  if (offlineHp != null && offlineHp > 0) return Math.round(offlineHp);
  return null;
}

/** Death times for ships the replay stream never caught sinking. Modern
 *  clients emit no EntityDestroy and the HP stream only reads 0 when the
 *  sink was OBSERVED — a ship killed while un-spotted keeps its last (often
 *  full) HP reading and stays "alive" through the whole playback. The
 *  post-battle payload is authoritative for WHO sank (`killerId`, index
 *  408 — null for survivors; using it rather than the `alive` flag, which
 *  reads false on layouts predating index 21). The sink MOMENT is not
 *  recoverable from the stream, so the ship's last observed moment stands
 *  in: it is the earliest instant the sink could have happened, and from
 *  there on the ship correctly renders sunk instead of sailing at full HP.
 *  Returns entityId → inferred death time. */
export function inferDarkDeaths(
  trajectories: EntityTrajectory[],
  pb: PostBattleData | null,
  vehicles: VehicleEntry[],
  arenaPlayers: ArenaPlayer[] | undefined,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!pb?.players) return out;
  // Post-battle players carry WG account ids — the roster join bridges by
  // name first (the same bridge the kill feed uses), account id second.
  const pbByName = new Map<string, (typeof pb.players)[number]>();
  for (const p of pb.players) {
    const n = (p.name ?? "").trim().toLowerCase();
    if (n) pbByName.set(n, p);
  }
  const vehicleByAccount = new Map<number, VehicleEntry>();
  for (const v of vehicles) if (v.id) vehicleByAccount.set(v.id, v);
  // Vehicle → trajectory: the arena join (roster player id → entity id,
  // authoritative for mirror picks), else a unique EntityCreate shipId join.
  const entityIdByPlayerId = new Map<number, number>();
  for (const p of arenaPlayers ?? []) {
    if (p.playerId) entityIdByPlayerId.set(p.playerId, p.entityId);
  }
  const trajByEntityId = new Map(trajectories.map((tr) => [tr.entityId, tr]));
  const byShipId = new Map<number, EntityTrajectory[]>();
  for (const tr of trajectories) {
    const sid = tr.kind?.shipId;
    if (sid == null) continue;
    const arr = byShipId.get(sid) ?? [];
    arr.push(tr);
    byShipId.set(sid, arr);
  }
  const trajOfVehicle = (v: VehicleEntry): EntityTrajectory | undefined => {
    const eid = entityIdByPlayerId.get(v.id);
    const byArena = eid != null ? trajByEntityId.get(eid) : undefined;
    if (byArena) return byArena;
    const sameShip = v.shipId != null ? byShipId.get(v.shipId) : undefined;
    return sameShip && sameShip.length === 1 ? sameShip[0] : undefined;
  };
  for (const [name, p] of pbByName) {
    // killerId != null ⟹ definitely sank; ships with no killer attribution
    // are treated as survivors (a missing field must never mark the living
    // dead).
    if (p.killerId == null) continue;
    const v =
      vehicles.find((x) => (x.name ?? "").trim().toLowerCase() === name) ??
      (p.accountId ? vehicleByAccount.get(p.accountId) : undefined);
    if (!v) continue;
    const traj = trajOfVehicle(v);
    // Only observed ships (a last-known moment exists) without a decoded
    // death need the inference; entityType 2 keeps planes/zones out.
    if (
      !traj ||
      traj.kind?.entityType !== 2 ||
      traj.deathTime != null ||
      (traj.samples.length === 0 && (traj.hpSamples?.length ?? 0) === 0)
    ) {
      continue;
    }
    const lastPos = traj.samples[traj.samples.length - 1]?.time ?? 0;
    const lastHp = traj.hpSamples?.[traj.hpSamples.length - 1]?.time ?? 0;
    const lastSeen = Math.max(lastPos, lastHp);
    if (lastSeen > 0) out.set(traj.entityId, lastSeen);
  }
  return out;
}

/** Patch `inferDarkDeaths` into the trajectories in place (load-time
 *  normalization — every downstream consumer then reads one uniform
 *  deathTime). Returns the entity ids whose deathTime was INFERRED (not
 *  stream-decoded): those sinks were never observed, so heuristics that
 *  credit a kill from death-time proximity must stand down for them — the
 *  post-battle payload's killer attribution is the only authority. */
export function applyDarkDeathInference(
  trajectories: EntityTrajectory[],
  pb: PostBattleData | null,
  vehicles: VehicleEntry[],
  arenaPlayers: ArenaPlayer[] | undefined,
): Set<number> {
  const inferred = inferDarkDeaths(trajectories, pb, vehicles, arenaPlayers);
  for (const tr of trajectories) {
    const t = inferred.get(tr.entityId);
    if (t != null) tr.deathTime = t;
  }
  return new Set(inferred.keys());
}
