/**
 * Carrier-airframe picker options: named, ranked and grouped by role.
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
 * picker is identical to the slice's. A row carries:
 *  - `label`: the aircraft's model designation ("Nakajima C6N5 1b", "J5N"),
 *    derived from the baked model path in plane_models.json — that is the
 *    airframe actually staged, and several GameParams entities can share one
 *    (dive/torpedo squadrons reusing a fighter model), so it is the one name
 *    true to what the viewer shows. The raw entity suffix is the fallback
 *    when the committed table does not cover a newer airframe.
 *  - `role`: the combat role from plane_types.json (torpedo / AP bomber /
 *    rocket …); the dropdown uses it as the group heading, in the same order
 *    as PLANE_ROLE_ORDER.
 *  - `config`: which version of the role's aircraft the row is — the base
 *    airframe of a hull configuration (`…_stock`) or its upgraded variant
 *    (`…_top`, plus the transitional `_tact`/`_jet`/`_alt` suffixes).
 *    null when the suffix names no known configuration (event squadrons).
 * The live slice, once loaded, re-runs the same pipeline on fresher data and
 * replaces the seed wholesale.
 */
import planeModelsDb from "@/data/plane_models.json";
import planeTypesDb from "@/data/plane_types.json";
import squadronsDb from "@/data/ship_squadrons.json";

// ── Picker row contract ──────────────────────────────────────────────

/** Version rank of an airframe inside its role group: the base aircraft of a
 *  hull configuration vs its upgraded / variant counterpart. */
export type PlaneConfigRank = "base" | "variant";

/** One row of the ship-detail airframe picker. */
export interface PlaneModelOption {
  /** Baked GLB stem — also the picker's value ("PJAB210"). */
  index: string;
  /** Player-facing airframe name (model designation, see the header). */
  label: string;
  /** Combat-role key used as the menu group heading ("torpedo", …); "" when
   *  plane_types.json does not map the airframe. */
  role: string;
  /** Version rank inside the role group; null when undetectable. */
  config: PlaneConfigRank | null;
}

/** Picker rows sharing one role heading. */
export interface PlaneModelGroup {
  /** Role key ("" = the ungrouped fallback bucket, rendered without a heading). */
  role: string;
  options: PlaneModelOption[];
}

// ── Plane picker role labels ──────────────────────────────────────────
// plane_types.json carries a `role` per airframe (derived from the carried
// ammunition by scripts/model_convert/extract_plane_types.py): a GameParams
// suffix like "Hakuryu stock" is a hull config, not an aircraft type, and
// three squadrons of one ship share it. The order below also orders the
// picker groups.
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

// ── Aircraft model names (data/plane_models.json) ─────────────────────
// plane_models.json maps each committed airframe entity name to its VFS
// .geometry path; the last path segment is the model stem
// ("JAB710_Nakajima_C6N5_1b_proto"), whose container prefix and "_proto"
// marker drop away to the designation players read.

/** Entity name ("PJAB110_Hakuryu_stock") per baked airframe index ("PJAB110"). */
const planeEntityByIndex = new Map<string, string>(
  (Object.values(planeTypesDb) as Array<{ index: string; name?: string }>).map(
    (m) => [m.index, m.name ?? ""],
  ),
);

const planeModelPathByEntity = planeModelsDb as Record<string, string | undefined>;

/** Model-stem container prefix ("JAB710_", "AAB702_") — one to three nation/
 *  family letters followed by the numeric id. */
const MODEL_STEM_PREFIX_RE = /^[A-Z]{1,3}\d+_/;

/** Model stems that are only the container id ("XAB001"): some collab /
 *  event airframes point at a shared container whose directory carries no
 *  model designation, and the entity tail ("Grumman TBF") names the
 *  aircraft instead. */
const CONTAINER_ONLY_RE = /^[A-Z]{1,3}\d+$/;

/** Aircraft model designation for one baked airframe index, or null when the
 *  committed tables do not cover it (a newer airframe, an unmapped entity). */
export function aircraftModelOf(index: string): string | null {
  const entity = planeEntityByIndex.get(index);
  if (!entity) return null;
  const path = planeModelPathByEntity[entity];
  if (!path) return null;
  const cut = path.lastIndexOf("/");
  if (cut < 0) return null;
  const modelDir = path.slice(0, cut).split("/").pop();
  const name = modelDir
    ? modelDir
        .replace(MODEL_STEM_PREFIX_RE, "")
        .replace(/_(?:proto|prototype)$/i, "")
        .replace(/_/g, " ")
        .trim()
    : "";
  if (name && !CONTAINER_ONLY_RE.test(name)) return name;
  const tail = entity.replace(/^[A-Z]+\d+_/, "").replace(/_/g, " ").trim();
  return tail || null;
}

// ── Version rank (base / variant) ─────────────────────────────────────
// The squadrons a ship can field differ by hull configuration, and GameParams
// spells that into the entity suffix: "Hakuryu stock" / "Hakuryu top". The
// label pipeline only needs the version word — the hull name itself is noise
// here (the airframe name says which aircraft it is).

const CONFIG_MARKERS: Record<string, PlaneConfigRank> = {
  stock: "base",
  base: "base",
  top: "variant",
  tact: "variant",
  jet: "variant",
  alt: "variant",
};

/** Version rank of an airframe from its raw entity suffix. The marker is
 *  looked up from the end of the suffix because trailing bake markers
 *  ("…_stock_WARD") must not hide it; null when no known marker is present. */
export function planeConfigRank(rawSuffix: string): PlaneConfigRank | null {
  const tokens = rawSuffix.toLowerCase().split(/[\s_]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const rank = CONFIG_MARKERS[tokens[i]];
    if (rank) return rank;
  }
  return null;
}

/** Entity-name shape: index prefix + descriptive tail ("PAAB002_Grumman_TBF").
 *  The prefix is the picker's identity (the baked GLB stem); the tail names
 *  the configuration / aircraft. */
const INDEX_RE = /^([A-Z]+\d+)_(.+)$/;

// ── Baked seed (data/ship_squadrons.json) ───────────────────────────

/** One ship's baked squadron block, as written by
 *  scripts/model_convert/extract_ship_squadrons.py. */
export interface SquadronSeedEntry {
  /** The ship's own GameParams entity name ("PJSA110_Hakuryu"). Kept as the
   *  bake's provenance and pinned by the table-integrity tests; the picker
   *  no longer needs it for labelling. */
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

/** Version rank for sorting: base first, then variant, unknown last. */
function configSortRank(option: PlaneModelOption): number {
  if (option.config === "base") return 0;
  if (option.config === "variant") return 1;
  return 2;
}

function roleSortRank(option: PlaneModelOption): number {
  const i = PLANE_ROLE_ORDER.indexOf(option.role);
  return i < 0 ? PLANE_ROLE_ORDER.length : i;
}

/** Dedupe by index, name + rank every row, order by role then version. Shared
 *  by the live slice and the baked seed so the picker never changes what it
 *  shows when the slice replaces the seed. */
function finalizeOptions(planeNames: string[]): PlaneModelOption[] {
  try {
    const seen = new Set<string>();
    const out: PlaneModelOption[] = [];
    for (const name of planeNames) {
      const m = INDEX_RE.exec(name);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const index = m[1];
      const suffix = m[2].replace(/_/g, " ").trim();
      out.push({
        index,
        label: aircraftModelOf(index) ?? (suffix || index),
        role: planeRoleOf(index),
        config: planeConfigRank(suffix),
      });
    }
    // Role first, then the role KEY (unknown roles all share one rank, so
    // this keeps each of them contiguous for grouping), then version rank,
    // then the baked index.
    out.sort((a, b) =>
      roleSortRank(a) - roleSortRank(b)
      || a.role.localeCompare(b.role)
      || configSortRank(a) - configSortRank(b)
      || a.index.localeCompare(b.index));
    return out;
  } catch {
    return [];
  }
}

/** Group sorted picker rows under their role heading, preserving the row
 *  order. Rows with an unmapped role land in one trailing unlabelled bucket
 *  (role "") so the menu can still list them. */
export function groupPlaneModelOptions(
  options: PlaneModelOption[],
): PlaneModelGroup[] {
  const groups: PlaneModelGroup[] = [];
  const byRole = new Map<string, PlaneModelGroup>();
  for (const option of options) {
    let group = byRole.get(option.role);
    if (!group) {
      group = { role: option.role, options: [] };
      byRole.set(option.role, group);
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

/** Whether a whole role group reads as versioned: it lists more than one
 *  airframe and every one carries a known rank. The base/variant distinction
 *  only reads as such in such a section; one mixing ranked squadrons with
 *  aircraft-named ones (the older "1942/1944" carrier configs) would
 *  otherwise tag half its rows and leave the rest bare. */
export function groupShowsVersionTags(group: PlaneModelGroup): boolean {
  return (
    group.options.length > 1 && group.options.every((option) => option.config != null)
  );
}

/** Per-row version-tag visibility. A row shows its tag when its whole
 *  section reads as versioned (groupShowsVersionTags), or when the row's
 *  label is shared with a sibling: a mixed-rank section (Lesta "…_ALT"
 *  airframes) can otherwise fold two airframes into one indistinguishable
 *  row, and the tag is exactly what tells them apart. */
export function showsVersionTag(
  group: PlaneModelGroup,
  option: PlaneModelOption,
): boolean {
  if (option.config == null) return false;
  if (groupShowsVersionTags(group)) return true;
  return group.options.some(
    (other) => other.index !== option.index && other.label === option.label,
  );
}

/** Picker options from the LIVE GameParams slice: one entry per squadron
 *  airframe embedded top-level on the slice ({ planes: [...] } blocks).
 *  Empty when the slice carries no squadrons — ships without embarked
 *  aircraft get no dropdown, exactly as before. */
export function buildPlaneOptionsFromSlice(
  gp: Record<string, unknown> | null,
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
  return finalizeOptions(names);
}

/** Picker options from the baked seed — instant, no GameParams involved.
 *  This is what makes the dropdown and the aircraft-view hint appear the
 *  moment the modal opens instead of after the install unpack. */
export function buildPlaneOptionsFromSeed(
  seed: SquadronSeedEntry,
): PlaneModelOption[] {
  if (!seed.planes?.length) return [];
  return finalizeOptions(seed.planes);
}
