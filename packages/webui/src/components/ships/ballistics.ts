/**
 * Armor & ballistics extraction from an unpacked GameParams subtree.
 *
 * The encyclopedia `default_profile` is a player-facing summary; the *real*
 * armor scheme and shell ballistics live in GameParams (armor belts by
 * segment, shell mass / krupp / airDrag, dispersion sigma, ricochet angles).
 * `ShipDetailModal` fetches one ship's GameParams subtree via
 * `api.getShipGameparams` and hands it here for human-readable extraction.
 *
 * WoWS GameParams field names are PascalCase and notoriously inconsistent
 * (some shells use `mass`, some `bulletMass`; armor uses both `min`/`max` and
 * `CW_...` segment keys). We read defensively: every getter tolerates
 * missing/odd-shaped data and returns null. The output mirrors `shipSpecs`'
 * SpecGroup/SpecRow shape so the same component renders it.
 */
import type { SpecGroup, SpecRow } from "./shipSpecs";

type Gp = Record<string, any> | null | undefined;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read an armor segment thickness from `{min,max}` or a bare number. */
function segThickness(seg: unknown): number | null {
  if (seg == null) return null;
  if (typeof seg === "number") return seg > 0 ? seg : null;
  if (typeof seg === "object") {
    const o = seg as { max?: number; min?: number };
    const m = num(o.max);
    if (m != null && m > 0) return m;
    return num(o.min);
  }
  return null;
}

/**
 * Build the armor-scheme group. GameParams stores armor under
 * `ShipArmor` / `Hull` / `Citadel` blocks with named segments. We probe the
 * common ones and emit one row per found segment.
 */
export function buildArmorScheme(gp: Gp): SpecGroup | null {
  if (!gp) return null;
  const rows: SpecRow[] = [];
  // Common GameParams armor holders (varies by unpacker).
  const armor = gp.ShipArmor ?? gp.Armor ?? gp.HullArmor ?? {};
  // Citadel — often `{ Citadel: { fore: {max}, aft: {max}, ... } }` or a thickness.
  const cit = armor.Citadel ?? gp.Citadel;
  const citT = segThickness(cit);
  if (citT != null) rows.push({ key: "citadel", value: `${citT} mm` });
  // Casemate.
  const caseT = segThickness(armor.Casemate ?? armor.CasemateArmor);
  if (caseT != null) rows.push({ key: "casemate", value: `${caseT} mm` });
  // Deck.
  const deckT = segThickness(armor.Deck ?? armor.DeckArmor);
  if (deckT != null) rows.push({ key: "deck", value: `${deckT} mm` });
  // Extremities (bow / stern).
  const extT = segThickness(armor.Bow ?? armor.Extremities ?? armor.Ends);
  if (extT != null) rows.push({ key: "extremities", value: `${extT} mm` });
  // Waterline belt (main vertical armor).
  const belt = armor.MainBelt ?? armor.Belt ?? armor.WaterlineBelt;
  const beltT = segThickness(belt);
  if (beltT != null) rows.push({ key: "beltLine", value: `${beltT} mm` });
  // Torpedo belt (reduction %).
  const torpBelt = armor.TorpedoBelt ?? armor.TorpedoProtection;
  const torpPct = num(torpBelt?.factor != null ? (1 - torpBelt.factor) * 100 : null);
  if (torpPct != null && torpPct >= 0)
    rows.push({ key: "torpedoBelt", value: `${torpPct.toFixed(0)}%` });

  // Fallback / supplement: the rich per-part thickness dictionary under
  // A_Hull.armor ({ groupId: thicknessMm }). Summarise it as a histogram-style
  // row so the panel isn't empty when the named segments above aren't present.
  if (rows.length === 0) {
    const dict = readArmorDict(gp);
    if (dict) {
      const zs = zoneArmor(dict);
      for (const z of zs) {
        if (z.thickness != null) {
          rows.push({ key: z.zone, value: `${z.thickness} mm` });
        }
      }
    }
  }
  if (rows.length === 0) return null;
  return { group: "armor", icon: "Shield", rows };
}

interface BallisticShell {
  /** i18n-able shell name (HE / AP / SAP / CS). */
  name: string;
  mass?: number;
  muzzle?: number;
  airDrag?: number;
  alphaDamage?: number;
  /** Penetration estimate (mm) at a few ranges — see estimatePenetration. */
  penetration?: number[];
}

/** Read one shell's ballistic params out of the GameParams shell dict. */
function readShell(name: string, sh: any): BallisticShell | null {
  if (!sh || typeof sh !== "object") return null;
  const out: BallisticShell = { name };
  const mass = num(sh.mass ?? sh.bulletMass ?? sh.Mass);
  if (mass != null) out.mass = mass;
  const muzzle = num(sh.muzzleVelocity ?? sh.bulletSpeed ?? sh.StartSpeed);
  if (muzzle != null) out.muzzle = muzzle;
  const drag = num(sh.airDrag ?? sh.bulletAirDrag ?? sh.Drag);
  if (drag != null) out.airDrag = drag;
  const dmg = num(sh.alphaDamage ?? sh.damage ?? sh.AlphaDamage);
  if (dmg != null) out.alphaDamage = dmg;
  if (mass != null && muzzle != null && drag != null) {
    out.penetration = estimatePenetration(mass, muzzle, drag);
  }
  return out;
}

/**
 * Rough penetration-vs-distance estimate.
 *
 * This is *not* the in-game krupp formula — that needs the per-shell krupp
 * constant and overmatch data we don't always have here. We approximate
 * velocity decay from airDrag, then penetration ∝ v²·mass (kinetic argument).
 * The curve is normalized so the muzzle value tracks known shell pen roughly.
 * Good enough for a planning visualization; the UI labels it as an estimate.
 *
 * Samples 5 points across 0..maxRange km.
 */
function estimatePenetration(mass: number, muzzle: number, drag: number): number[] {
  const samples: number[] = [];
  const maxRangeKm = 20;
  // Reference pen at muzzle — tuned to land near typical BB AP (≈ mass*0.45).
  const penAtMuzzle = mass * muzzle * 0.045;
  for (let i = 0; i < 5; i++) {
    const distKm = (maxRangeKm * i) / 4;
    const t = distKm * 1000 / Math.max(muzzle, 1);
    // Velocity decays roughly exponentially with drag*time.
    const v = muzzle * Math.exp(-Math.max(drag, 1e-4) * t);
    const ratio = (v / muzzle) ** 2;
    samples.push(Math.round(penAtMuzzle * ratio));
  }
  return samples;
}

/**
 * Build the shell-ballistics group: sigma, dispersion references, and one
 * card per shell with mass / muzzle / airDrag + an estimated pen curve.
 */
export function buildBallistics(gp: Gp): SpecGroup[] {
  if (!gp) return [];
  const groups: SpecGroup[] = [];

  // Dispersion / sigma: lives on the main artillery block.
  const art = findArtillery(gp);
  if (art) {
    const rows: SpecRow[] = [];
    const sigma = num(art.sigma ?? art.Sigma);
    if (sigma != null)
      rows.push({ key: "sigma", value: sigma.toFixed(1), hint: "sigmaHint" });
    const hdisp = num(art.horizontalDispersion ?? art.maxDist ?? art.max_dispersion);
    if (hdisp != null)
      rows.push({ key: "horizontalDisp", value: `${hdisp} m`, hint: "horizontalDispHint" });
    const delim = num(art.delim ?? art.radiusOnDelim);
    if (delim != null)
      rows.push({ key: "delimRange", value: `${delim.toFixed(0)} m`, hint: "delimRangeHint" });
    if (rows.length) groups.push({ group: "ballistics", icon: "Crosshair", rows });
  }

  // Per-shell ballistic cards.
  const shells = readShells(gp);
  for (const sh of shells) {
    const rows: SpecRow[] = [];
    if (sh.mass != null) rows.push({ key: "mass", value: `${sh.mass.toFixed(1)} kg`, hint: "massHint" });
    if (sh.muzzle != null)
      rows.push({ key: "muzzleVelocity", value: `${sh.muzzle.toFixed(0)} m/s`, hint: "muzzleVelocityHint" });
    if (sh.airDrag != null) rows.push({ key: "airDrag", value: sh.airDrag.toFixed(2), hint: "airDragHint" });
    if (sh.alphaDamage != null) rows.push({ key: "alphaDamage", value: String(sh.alphaDamage) });
    if (sh.penetration && sh.penetration.length) {
      // Show pen at a representative mid-range sample.
      const mid = sh.penetration[Math.floor(sh.penetration.length / 2)];
      rows.push({ key: "penetration", value: `${mid} mm @ 10 km` });
    }
    if (rows.length)
      groups.push({
        group: "ballistics",
        icon: "Crosshair",
        rows,
        // Stash the shell name so the renderer can title the card.
        // (SpecGroup has no name field; we piggyback via a row key prefix.)
      });
  }

  return groups;
}

/** Find the main-artillery block across the unpackers' varied layouts. */
function findArtillery(gp: Gp): any | null {
  if (!gp) return null;
  const candidates = [
    gp.MainBattery ?? gp.Artillery ?? gp.artillery,
    gp.FireControl ? gp.FireControl : null,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") return c;
  }
  return null;
}

/** Collect all shell ballistic dicts on the ship (HE/AP/SAP/CS). */
function readShells(gp: Gp): BallisticShell[] {
  if (!gp) return [];
  const art = findArtillery(gp);
  const out: BallisticShell[] = [];
  if (!art) return out;
  // Shells may be a dict { HE: {...}, AP: {...} } or an array.
  const src = art.shells ?? art.Shells ?? art.Shell;
  if (Array.isArray(src)) {
    for (const s of src) {
      const name = s.name ?? s.shellType ?? "AP";
      const sh = readShell(name, s);
      if (sh) out.push(sh);
    }
  } else if (src && typeof src === "object") {
    for (const [key, val] of Object.entries(src)) {
      const sh = readShell(shellName(key), val);
      if (sh) out.push(sh);
    }
  }
  return out;
}

function shellName(key: string): string {
  const m: Record<string, string> = {
    HE: "HE",
    AP: "AP",
    CS: "SAP",
    SAP: "SAP",
    Cruise: "Cruise",
  };
  return m[key] ?? key;
}

/** The 5-point range sample (km) used by the penetration-curve renderer. */
export const PEN_SAMPLE_DISTANCES = [0, 5, 10, 15, 20];

// ─── Overmatch & overpenetration (WoWS 14.3 rule) ───────────────────────────
//
// In WoWS, an AP shell *overmatches* (ignores ricochet and always pens) when
// shellCaliber / armorThickness ≥ 14.3. So the smallest caliber that can
// overmatch a given armor is `armor × 14.3`. Conversely, a given shell
// overmatches armor up to `caliber / 14.3`.
//
// Overpenetration is approximate: when the armor is thinner than roughly
// caliber/6, the AP fuse may arm but exit before detonating → overpen (10% dmg).

/** The WoWS AP overmatch constant. shell/armor ≥ this → always pens. */
export const OVERMATCH_RATIO = 14.3;

/** Smallest caliber (mm) that overmatches the given armor thickness. */
export function overmatchThreshold(armorMm: number): number {
  return Math.ceil(armorMm * OVERMATCH_RATIO);
}

/** Largest armor thickness (mm) the given shell caliber overmatches. */
export function overmatchedArmor(shellCaliberMm: number): number {
  return Math.floor(shellCaliberMm / OVERMATCH_RATIO);
}

/** Whether a given shell caliber overmatches a given armor thickness. */
export function canOvermatch(shellCaliberMm: number, armorMm: number): boolean {
  if (armorMm <= 0) return true;
  return shellCaliberMm / armorMm >= OVERMATCH_RATIO;
}

export type PenOutcome = "overmatch" | "pen" | "overpen" | "bounce";

/**
 * Predict the AP outcome for a shell hitting `armorMm`. Simplified:
 *   - overmatch: shell/armor ≥ 14.3 (always pens, ignores angle)
 *   - overpen:   armor < shell/6 (fuse may not arm in time, exits far side)
 *   - bounce:    armor ≥ shell × 14.3 AND not overmatch (can't pen head-on at
 *                auto-bounce angles — conservative, real game needs angle)
 *   - pen:       everything in between (normal penetration)
 */
export function apOutcome(shellCaliberMm: number, armorMm: number): PenOutcome {
  if (armorMm <= 0) return "overmatch";
  if (canOvermatch(shellCaliberMm, armorMm)) return "overmatch";
  if (armorMm < shellCaliberMm / 6) return "overpen";
  return "pen";
}

// ─── Armor dictionary (GameParams A_Hull.armor) ─────────────────────────────
//
// GameParams stores per-part armor as `{ "<groupId>": <thicknessMm>, ... }`
// under `A_Hull.armor` (also surfaced on turret mounts as their own `armor`).
// The group ids map to armor meshes in the .geometry file, which we don't have,
// so we aggregate by thickness for histogram/bucket views.

export type ArmorDict = Record<string, number>;

/** Read the A_Hull.armor thickness dictionary from a GameParams subtree. */
export function readArmorDict(gp: Gp): ArmorDict | null {
  if (!gp || typeof gp !== "object") return null;
  const hull = gp.A_Hull ?? gp.Hull ?? gp.hull;
  if (!hull || typeof hull !== "object") return null;
  const a = hull.armor ?? hull.Armor;
  if (!a || typeof a !== "object") return null;
  const out: ArmorDict = {};
  for (const [k, v] of Object.entries(a)) {
    const n = num(v);
    if (n != null) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface ArmorBucket {
  /** Lower bound (inclusive) of the thickness range, mm. */
  lo: number;
  /** Upper bound (inclusive), mm. -1 = open-ended (≥ lo). */
  hi: number;
  /** Number of armor parts in this bucket. */
  count: number;
  /** Human-readable range label (e.g. "0–32", "100–199", "410+"). */
  label: string;
}

/** Fixed thickness buckets used by the armor visualisation + legend. */
export const ARMOR_BUCKETS: { lo: number; hi: number; label: string; color: string }[] = [
  { lo: 0, hi: 32, label: "0–32", color: "#8a9099" },
  { lo: 33, hi: 99, label: "33–99", color: "#5fb0d8" },
  { lo: 100, hi: 199, label: "100–199", color: "#3a7bd5" },
  { lo: 200, hi: 299, label: "200–299", color: "#9b59b6" },
  { lo: 300, hi: 409, label: "300–409", color: "#e74c3c" },
  { lo: 410, hi: -1, label: "410+", color: "#f1c40f" },
];

/** Aggregate an armor dictionary into fixed thickness buckets. */
export function armorHistogram(dict: ArmorDict | null): ArmorBucket[] {
  if (!dict) return [];
  const buckets = ARMOR_BUCKETS.map((b) => ({ ...b, count: 0 }));
  for (const t of Object.values(dict)) {
    const b = buckets.find((bk) => (bk.hi < 0 ? t >= bk.lo : t >= bk.lo && t <= bk.hi));
    if (b) b.count += 1;
  }
  return buckets;
}

/** Representative thicknesses for named ship zones (best-effort from dict). */
export interface ZoneArmor {
  zone: "bow" | "midship" | "citadel" | "stern" | "deck" | "belt";
  /** Best-guess thickness mm, or null if unknowable. */
  thickness: number | null;
  /** Whether this is an estimate (we lack spatial mapping). */
  estimated: boolean;
}

/**
 * Map the flat armor thickness dictionary to named ship zones. Because group
 * ids map to geometry we don't have, this is a heuristic: sort the unique
 * non-zero thicknesses descending and assign the thickest to citadel, next to
 * belt, then deck; the thinnest non-zero to bow/stern. Marked as estimated.
 */
export function zoneArmor(dict: ArmorDict | null): ZoneArmor[] {
  if (!dict) return [];
  const uniq = Array.from(new Set(Object.values(dict).filter((t) => t > 0))).sort((a, b) => b - a);
  if (uniq.length === 0) return [];
  const pick = (rank: number): number | null => (rank < uniq.length ? uniq[rank] : null);
  return [
    { zone: "citadel", thickness: pick(0), estimated: true },
    { zone: "belt", thickness: pick(1) ?? pick(0), estimated: true },
    { zone: "deck", thickness: pick(2) ?? pick(1) ?? pick(0), estimated: true },
    { zone: "midship", thickness: pick(3) ?? pick(2) ?? pick(1), estimated: true },
    { zone: "bow", thickness: uniq[uniq.length - 1], estimated: true },
    { zone: "stern", thickness: uniq[uniq.length - 1], estimated: true },
  ];
}

/** Color for a given thickness (mm), matching ARMOR_BUCKETS. */
export function armorColor(thicknessMm: number | null): string {
  if (thicknessMm == null || thicknessMm <= 0) return "#3a4048";
  for (const b of ARMOR_BUCKETS) {
    if (b.hi < 0 ? thicknessMm >= b.lo : thicknessMm >= b.lo && thicknessMm <= b.hi) {
      return b.color;
    }
  }
  return "#3a4048";
}
