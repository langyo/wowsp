/**
 * Carrier-airframe picker options, labelled and ordered.
 *
 * ShipDetailModal's model dropdown and the aircraft-view hint list the
 * airframes a ship embarks. The only runtime source for that list used to be
 * the ship's GameParams slice — on desktop it is unpacked from the install
 * on first use (one VFS mount + full GameParams pickle decode, several
 * seconds per ship missing from the per-ship AppData cache), so the dropdown
 * and the hint popped in late on every carrier / hybrid opened for the first
 * time. scripts/model_convert/extract_ship_squadrons.py therefore bakes the
 * ship -> squadron mapping into data/ship_squadrons.json, mirroring the
 * backend's served-slice pick and the top-level planes scan below, and the
 * modal seeds both surfaces from it the moment the modal opens.
 *
 * Both sources funnel through the same labelling pipeline so the seed's
 * picker is identical to the slice's: role names from plane_types.json
 * (whose order also groups the entries), plus a qualifier distilled from the
 * raw entity suffix when a ship fields two airframes of one role ("Hakuryu
 * stock" -> the stock marker). The live slice, once loaded, re-runs the same
 * pipeline on fresher data and replaces the seed wholesale.
 */
import { t } from "@/i18n";
import planeTypesDb from "@/data/plane_types.json";
import squadronsDb from "@/data/ship_squadrons.json";
import type { PlaneModelOption } from "./ShipStage";

// ── Plane picker role labels ──────────────────────────────────────────
// plane_types.json carries a `role` per airframe (derived from the carried
// ammunition by scripts/model_convert/extract_plane_types.py): a GameParams
// suffix like "Hakuryu stock" is a hull config, not an aircraft type, and
// three squadrons of one ship share it. The order below also groups the
// picker entries by role.
const PLANE_ROLE_ORDER = [
  "torpedo", "heBomber", "apBomber", "heSkip", "apSkip",
  "rocket", "fighter", "scout", "asw", "mine",
];

const planeRoleByIndex = new Map<string, string>(
  (Object.values(planeTypesDb) as Array<{ index: string; role?: string }>).map(
    (m) => [m.index, m.role ?? ""],
  ),
);

function planeRoleOf(index: string): string {
  return planeRoleByIndex.get(index) ?? "";
}

/** Translated role name; unmapped roles (special airstrike planes etc.) fall
 *  back to `fallback` — the raw entity suffix. */
function planeRoleLabel(role: string, fallback: string): string {
  if (!role) return fallback;
  const key = `ships.plane.${role}`;
  const msg = t(key, {});
  return msg === key ? fallback : msg;
}

/** Entity-name shape: index prefix + descriptive tail ("PAAB002_Grumman_TBF").
 *  The prefix is the picker's identity (the baked GLB stem); the tail feeds
 *  the qualifier distillation below. */
const INDEX_RE = /^([A-Z]+\d+)_(.+)$/;

// ── Baked seed (data/ship_squadrons.json) ───────────────────────────

/** One ship's baked squadron block, as written by
 *  scripts/model_convert/extract_ship_squadrons.py. */
export interface SquadronSeedEntry {
  /** The ship's own GameParams entity name ("PJSA110_Hakuryu") — the
   *  qualifier distillation strips its tokens from the raw suffixes, the
   *  same job gp.name does on the live-slice path. */
  name?: string;
  /** Full airframe entity names; the bake already dropped airframes without
   *  a baked GLB and deduped by index prefix. */
  planes: string[];
  /** Lesta-only ship (the baking script's merge marker; no runtime effect —
   *  ids shared by both clients resolve through the user's own install). */
  lesta?: boolean;
}

const SEEDS = squadronsDb as Record<string, SquadronSeedEntry | undefined>;

/** Baked squadron seed for a ship id, or null when the table does not cover
 *  it — a ship newer than the dump simply falls back to the old behaviour:
 *  the picker and the hint wait for the live GameParams slice. */
export function squadronSeed(
  shipId: number | string | null | undefined,
): SquadronSeedEntry | null {
  if (shipId == null) return null;
  return SEEDS[String(shipId)] ?? null;
}

// ── Labelling pipeline ───────────────────────────────────────────────

/** Dedupe by index, order by role, translate + qualify every label. Shared
 *  by the live slice and the baked seed so the picker never changes what it
 *  shows when the slice replaces the seed. */
function finalizeOptions(
  planeNames: string[],
  shipEntityName: string,
  shipDisplayName: string,
): PlaneModelOption[] {
  try {
    const seen = new Set<string>();
    const out: PlaneModelOption[] = [];
    const rawTailOf = new Map<string, string>();
    for (const name of planeNames) {
      const m = INDEX_RE.exec(name);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ index: m[1], label: m[1] });
      rawTailOf.set(m[1], m[2].replace(/_/g, " ").trim());
    }
    const fallbackRank = PLANE_ROLE_ORDER.length;
    const roleRank = (p: PlaneModelOption): number => {
      const i = PLANE_ROLE_ORDER.indexOf(planeRoleOf(p.index));
      return i < 0 ? fallbackRank : i;
    };
    out.sort((a, b) => roleRank(a) - roleRank(b));
    // Ship-name tokens (encyclopedia name + the GameParams entity name's
    // "PJSA917_TST_Hakuryu" tail) are stripped from the raw suffix so the
    // qualifier distills to stock/top-style residue.
    const gpName = String(shipEntityName ?? "");
    const gpTail = /^[A-Z]+\d+_(.*)$/.exec(gpName)?.[1] ?? gpName;
    const shipTokens = `${shipDisplayName ?? ""} ${gpTail}`
      .toLowerCase()
      .split(/[\s_]+/)
      .filter(Boolean);
    const roleCounts = new Map<string, number>();
    for (const p of out) {
      const role = planeRoleOf(p.index);
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
    for (const p of out) {
      const role = planeRoleOf(p.index);
      const raw = rawTailOf.get(p.index) ?? "";
      const key = `ships.plane.${role}`;
      const translated = role && t(key, {}) !== key;
      // Unmapped roles already fall back to the raw suffix, which then
      // carries its own qualifier — appending another would duplicate it.
      let label = planeRoleLabel(role, raw || p.index);
      if (translated && (roleCounts.get(role) ?? 0) > 1 && raw) {
        let qual = raw
          .split(" ")
          .filter((tok) => !shipTokens.includes(tok.toLowerCase()))
          .join(" ");
        const cfg = qual.toLowerCase();
        if (cfg === "stock" || cfg === "top") {
          const cfgKey = `ships.plane.cfg.${cfg}`;
          const msg = t(cfgKey, {});
          if (msg !== cfgKey) qual = msg;
        }
        if (qual && qual !== label) label += ` · ${qual}`;
      }
      p.label = label;
    }
    return out;
  } catch {
    return [];
  }
}

/** Picker options from the LIVE GameParams slice: one entry per squadron
 *  airframe embedded top-level on the slice ({ planes: [...] } blocks).
 *  Empty when the slice carries no squadrons — ships without embarked
 *  aircraft get no dropdown, exactly as before. */
export function buildPlaneOptionsFromSlice(
  gp: Record<string, unknown> | null,
  shipDisplayName: string,
): PlaneModelOption[] {
  if (!gp) return [];
  const names: string[] = [];
  for (const v of Object.values(gp)) {
    const planes = (v as { planes?: unknown } | null)?.planes;
    if (Array.isArray(planes)) {
      for (const name of planes) {
        if (typeof name === "string") names.push(name);
      }
    }
  }
  if (names.length === 0) return [];
  return finalizeOptions(names, String(gp.name ?? ""), shipDisplayName);
}

/** Picker options from the baked seed — instant, no GameParams involved.
 *  This is what makes the dropdown and the aircraft-view hint appear the
 *  moment the modal opens instead of after the install unpack. */
export function buildPlaneOptionsFromSeed(
  seed: SquadronSeedEntry,
  shipDisplayName: string,
): PlaneModelOption[] {
  if (!seed.planes?.length) return [];
  return finalizeOptions(seed.planes, seed.name ?? "", shipDisplayName);
}
