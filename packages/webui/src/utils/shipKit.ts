/**
 * Per-realm consumable kit selection (radar / hydro / smoke capability +
 * longest stock radii — see `scripts/extract_ship_consumable_kit.py`).
 *
 * The WG and Lesta clients share most ship ids while their consumable
 * loadouts and radar/hydro radii have diverged (Lesta rebalanced
 * independently — 290 of the kit'd shared ships carry different radii
 * between the two dumps), so a lookup must name the branch it renders and
 * the bake ships one asset per realm. The runtime hot-updated copies are
 * kept per branch too (`setRuntimeKit`) — a bad download degrades that
 * branch to its baked asset, never to empty numbers.
 */
import type { ShipDataBranch } from "@/utils/realms";
import kitWgRaw from "@/data/ship_consumable_kit.json";
import kitLestaRaw from "@/data/ship_consumable_kit_lesta.json";

/** Baked per-ship level per counted family (2 definite / 1 possible — see
 *  the generator's docstring) plus the longest stock radii in metres. */
export interface KitEntry {
  /** RLSSearch (radar). */
  r?: 1 | 2;
  /** SonarSearch (hydroacoustic search). */
  h?: 1 | 2;
  /** SmokeGenerator (ship smoke). */
  s?: 1 | 2;
  /** Longest stock radar detection radius, metres (only when r > 0). */
  radarM?: number;
  /** Longest stock hydroacoustic detection radius, metres (only when h > 0). */
  hydroM?: number;
}

type KitTable = Record<string, KitEntry>;

const BAKED: Record<ShipDataBranch, KitTable> = {
  wg: kitWgRaw as KitTable,
  lesta: kitLestaRaw as KitTable,
};

/** The runtime-downloaded copies (the shell's `data-latest` cache, read
 *  through `get_ship_kit`) — `null` while only the baked asset serves that
 *  branch. */
const runtime: Record<ShipDataBranch, KitTable | null> = { wg: null, lesta: null };

function parseKit(raw: string): KitTable | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: KitTable = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || value == null || typeof value !== "object") continue;
    const src = value as Record<string, unknown>;
    const level = (v: unknown): 1 | 2 | undefined =>
      v === 1 || v === 2 ? (v as 1 | 2) : undefined;
    const entry: KitEntry = {};
    const r = level(src.r);
    if (r) entry.r = r;
    const h = level(src.h);
    if (h) entry.h = h;
    const s = level(src.s);
    if (s) entry.s = s;
    if (typeof src.radarM === "number" && Number.isFinite(src.radarM) && src.radarM > 0) {
      entry.radarM = src.radarM;
    }
    if (typeof src.hydroM === "number" && Number.isFinite(src.hydroM) && src.hydroM > 0) {
      entry.hydroM = src.hydroM;
    }
    // An entry that validated to nothing is dropped wholesale — same
    // contract as the generator (a lookup miss means "all zeros").
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  // Nothing survived validation (or the body was an empty object): treat
  // it as a malformed download — the previous copy must stay, never be
  // replaced by an empty table that would zero every lookup.
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Overlay a runtime-downloaded kit onto ONE branch's baked asset. `null` /
 *  `undefined` (no downloadable cache) clears that branch back to the baked
 *  copy; anything malformed keeps the previous data — a bad download must
 *  degrade to known-good numbers, never to empty ones. Returns whether the
 *  branch's table changed. */
export function setRuntimeKit(
  raw: string | null | undefined,
  branch: ShipDataBranch,
): boolean {
  if (raw == null) {
    runtime[branch] = null;
    return true;
  }
  const parsed = parseKit(raw);
  if (parsed == null) return false;
  runtime[branch] = parsed;
  return true;
}

/** The kit entry for one ship in ONE branch — runtime copy first, baked
 *  asset underneath; `undefined` (a lookup miss) means the ship mounts none
 *  of the counted families, or this branch's bake predates it. */
export function kitEntryFor(
  shipId: number | string,
  branch: ShipDataBranch,
): KitEntry | undefined {
  const key = String(shipId);
  return (runtime[branch] ?? BAKED[branch])[key];
}
