/**
 * Per-player hull-variant resolver for the replay ship stats.
 *
 * One ship, many hulls: collaboration/event ships can mount SEVERAL
 * parallel loadout variants of the SAME shipId — GameParams ships them as
 * sibling `ShipUpgradeInfo` `_Hull` upgrades whose `prev` is empty (not an
 * A→B research chain; Bermuda Triangle's 远征者 / PXSC999_Siegfried_1510,
 * shipId 3247355152, ships FIVE — concealment 7..16.5 km, HP 30.7k..73k
 * across the variants and their event tiers). The baked
 * `ship_live_stats.json` is keyed by shipId and describes exactly one of
 * them, so the replay UI showed every player the same numbers.
 *
 * The replay's build decode already identifies the variant per player: the
 * decoded build's `units` (mounted modules, hull first) carry the mounted
 * upgrade's NUMERIC GameParams id, which `gameparamCode` resolves to the
 * upgrade's code (PXUH803_HULL_C …). This module joins that code against
 * the ship's own GameParams subtree — the same raw slice
 * `get_ship_gameparams` serves (hot data pack → bundled snapshot →
 * AppData cache → install paths; `features/replay/runtimeShipIdentity`
 * probes the identical subtree for unknown-ship identities, so the AppData
 * per-ship cache usually absorbs this module's fetch) — and derives a
 * PARTIAL `ShipLiveStats` override off the variant's hull component: the
 * hull's `visibilityFactor` / `visibilityFactorByPlane` ARE the sea/air
 * detection distances in km (the rule `components/ships/shipSpecs.ts`
 * documents), `health` is the hull HP, and `maxSpeed` the hull's top
 * speed when it carries one.
 *
 * Fire-and-forget by contract, mirroring `runtimeShipIdentity`: hosts
 * hand their decoded ally builds over (`registerEntityShipVariants`), the
 * slice is fetched at most once per (root, shipId, branch) per session,
 * every failure is swallowed, nothing toasts, nothing blocks — an entity
 * whose variant did not resolve simply keeps today's shipId-level stats.
 * Registrations land in plain (non-reactive) maps keyed by the build's
 * entity id AND player name (the live arena rows join by name — their
 * arena vehicle ids are a different id space than the decode's BigWorld
 * entity ids); `entityShipVariantEpoch` is the reactive render trigger.
 */
import { ref } from "vue";

import { api } from "@/api";
import type { PlayerBuild } from "@/api";
import { gameparamCode } from "./playerBuild";
import type { ShipLiveStats } from "./shipLiveStatsTypes";

/** The per-player partial that overrides the shipId-level bake. */
export type EntityShipVariantOverride = Pick<
  ShipLiveStats,
  "det" | "detAir" | "hp" | "spd"
>;

/** Finite number or null — everything arrives as `unknown` over RPC. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Resolve one decoded build's hull-variant override off the ship's raw
 *  GameParams slice. Pure (no fetch, no store) so the mapping is
 *  unit-tested directly against a synthetic subtree.
 *
 *  Walks the build's `units` in order (hull first, per the wire contract)
 *  and takes the FIRST id that names a `_Hull` upgrade in the slice's
 *  `ShipUpgradeInfo`; the upgrade's `components.hull[0]` names the nested
 *  hull component carrying the variant's numbers. Returns null when
 *  nothing matches — a build without decodable units, a code the baked
 *  id map does not know, a slice the install could not answer — and the
 *  caller keeps the shipId-level stats unchanged. */
export function shipVariantOverrideFromSlice(
  gp: unknown,
  units: readonly number[] | null | undefined,
): EntityShipVariantOverride | null {
  if (typeof gp !== "object" || gp === null) return null;
  if (!Array.isArray(units) || units.length === 0) return null;
  const root = gp as Record<string, unknown>;
  const sui = root.ShipUpgradeInfo;
  if (typeof sui !== "object" || sui === null) return null;
  const upgrades = sui as Record<string, unknown>;
  for (const id of units) {
    const code = gameparamCode(id);
    if (!code) continue;
    const upgrade = upgrades[code];
    if (typeof upgrade !== "object" || upgrade === null) continue;
    const entry = upgrade as { ucType?: unknown; components?: unknown };
    if (entry.ucType !== "_Hull") continue;
    const comps =
      typeof entry.components === "object" && entry.components !== null
        ? (entry.components as Record<string, unknown>)
        : null;
    const refs = Array.isArray(comps?.hull) ? (comps?.hull as unknown[]) : null;
    const hullRef = typeof refs?.[0] === "string" ? refs[0] : null;
    if (!hullRef) continue;
    const hull = root[hullRef];
    if (typeof hull !== "object" || hull === null) continue;
    const h = hull as Record<string, unknown>;
    const out: EntityShipVariantOverride = {};
    const det = num(h.visibilityFactor);
    if (det != null && det > 0) out.det = round1(det);
    const detAir = num(h.visibilityFactorByPlane);
    if (detAir != null && detAir > 0) out.detAir = round1(detAir);
    const hp = num(h.health);
    if (hp != null && hp > 0) out.hp = Math.round(hp);
    const spd = num(h.maxSpeed);
    if (spd != null && spd > 0) out.spd = round1(spd);
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

// ── Registry (plain state + epoch, mirroring runtimeShipIdentity) ────────

/** Bumped once new per-player registrations land — the render layer's
 *  reactive trigger (the registry is deliberately non-reactive). */
export const entityShipVariantEpoch = ref(0);

const byEntity = new Map<number, EntityShipVariantOverride>();
const byName = new Map<string, EntityShipVariantOverride>();

/** One slice fetch per (root, shipId, branch) per session — success AND
 *  failure both cache (a miss would miss again; see runtimeShipIdentity's
 *  same rule). */
const slices = new Map<string, Promise<unknown | null>>();

/** Whether an override is already registered for a key — the equality
 *  guard that keeps re-registration (a probe frame replacing the whole
 *  build set every few seconds) from re-bumping the epoch. */
function sameOverride(
  a: EntityShipVariantOverride | null | undefined,
  b: EntityShipVariantOverride | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.det === b.det &&
    a.detAir === b.detAir &&
    a.hp === b.hp &&
    a.spd === b.spd
  );
}

function sliceFor(
  shipId: number,
  gameRoot: string,
  branch: "wg" | "lesta" | undefined,
): Promise<unknown | null> {
  const key = `${gameRoot}#${shipId}@${branch ?? "wg"}`;
  let pending = slices.get(key);
  if (!pending) {
    pending = api
      .getShipGameparams(shipId, gameRoot, branch)
      .catch(() => null);
    slices.set(key, pending);
  }
  return pending;
}

/** Resolve every decoded build's hull variant against the ship's own
 *  GameParams slice, registering what resolves. Safe to call on every
 *  builds refresh: the per-ship fetch dedupes, and re-registering the
 *  SAME override is a no-op (no epoch bump, no re-render churn — probe
 *  frames replace the whole build set every few seconds). Fire-and-
 *  forget — the promise is never awaited and a failed fetch just leaves
 *  those players on the shipId-level stats.
 *
 *  Every decoded ally registers, not only event ships: whenever the
 *  mounted hull's numbers differ from the shipId-level bake (a player
 *  who never bought the top hull), the override is the truer value. */
export function registerEntityShipVariants(
  builds: readonly PlayerBuild[] | null | undefined,
  gameRoot: string,
  branch?: "wg" | "lesta",
): void {
  if (!Array.isArray(builds) || builds.length === 0) return;
  // Group by shipId first: seven players in one event ship share ONE
  // slice fetch (and every other multi-player ship in the battle does too).
  const perShip = new Map<number, PlayerBuild[]>();
  for (const build of builds) {
    if (!build || !Array.isArray(build.units) || build.units.length === 0) {
      continue;
    }
    if (!build.shipParamsId) continue;
    const group = perShip.get(build.shipParamsId) ?? [];
    group.push(build);
    perShip.set(build.shipParamsId, group);
  }
  for (const [shipId, group] of perShip) {
    void sliceFor(shipId, gameRoot, branch).then((gp) => {
      if (!gp) return;
      let added = false;
      for (const build of group) {
        const override = shipVariantOverrideFromSlice(gp, build.units);
        if (!override) continue;
        if (build.entityId != null && build.entityId !== 0) {
          if (!sameOverride(byEntity.get(build.entityId), override)) {
            byEntity.set(build.entityId, override);
            added = true;
          }
        }
        if (build.name) {
          if (!sameOverride(byName.get(build.name), override)) {
            byName.set(build.name, override);
            added = true;
          }
        }
      }
      if (added) entityShipVariantEpoch.value += 1;
    });
  }
}

/** The override registered for one entity — by the decoded build's entity
 *  id (replay surfaces: trajectories, vehicles and builds share the
 *  BigWorld id space), then by player name (the live arena rows, whose
 *  arena vehicle ids are a different id space). Null = keep the
 *  shipId-level stats. */
export function entityShipVariantFor(
  entityId: number | null | undefined,
  name: string | null | undefined,
): EntityShipVariantOverride | null {
  if (entityId != null && entityId !== 0) {
    const hit = byEntity.get(entityId);
    if (hit) return hit;
  }
  if (name) return byName.get(name) ?? null;
  return null;
}

/** Forget every per-player registration — the hosts call this when the
 *  BATTLE changes (a new replay opened, a new live battle armed). BigWorld
 *  entity ids and player names are reused across battles, so a stale
 *  registration would pin the PREVIOUS battle's hull numbers onto the
 *  next one whenever the new decode lands late or fails (the module's
 *  "unresolved keeps the bake" contract must not decay into "unresolved
 *  keeps the LAST battle's override"). The slice cache survives: it is
 *  keyed by root#shipId#branch — battle-independent ship data. */
export function resetEntityShipVariants(): void {
  byEntity.clear();
  byName.clear();
  entityShipVariantEpoch.value += 1;
}

/** Test hook: forget the registry AND the slice cache (pair with each
 *  mock's reset in the suites; the production reset above deliberately
 *  keeps the slices). */
export function resetEntityShipVariantsForTests(): void {
  resetEntityShipVariants();
  slices.clear();
}
