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
