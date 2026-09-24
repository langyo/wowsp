/**
 * Per-ship combat-card data for the live-battle panel (`/live`), served from
 * the baked asset `@/data/ship_live_stats.json` (generator:
 * `scripts/extract_ship_live_stats.py`; sources and merge rules are documented
 * there). The panel renders a whole roster and refreshes every 3 s, so every
 * value must be synchronously available — a static import beats 24 IPC calls
 * per roster, and keeps working where GameParams does not exist (phone app,
 * no game install).
 *
 * Every record is the ship's CAPABILITY, not a loadout: neither GameParams
 * nor the WG encyclopedia carries per-player equipment, signals or commander
 * state, so nothing here can identify what a specific player actually fitted.
 * The panel is careful to say so wherever these numbers surface.
 *
 * Formatting helpers (formatShipParams / shipConsumableLabel / …) return
 * plain strings keyed for the `replay.live.param.*` / `ships.consumable.*`
 * i18n namespaces, so components stay declarative.
 */
import liveStatsRaw from "@/data/ship_live_stats.json";
import { t } from "@/i18n";
import { i18n } from "@/i18n";
import type { AaBands, ShipLiveStats } from "./shipLiveStatsTypes";
import { tierToRoman } from "@wowsp/holo";

export type { AaBands, ShipLiveStats };

const LIVE_STATS = liveStatsRaw as Record<string, ShipLiveStats>;

/** Combat-card record for a shipId, or null when the bake has no entry
 *  (event ships outside both sources — the panel then shows no strip). */
export function shipLiveStats(shipId: number | string | undefined | null): ShipLiveStats | null {
  if (shipId == null) return null;
  return LIVE_STATS[String(shipId)] ?? null;
}

export function hasShipLiveStats(shipId: number | string | undefined | null): boolean {
  return shipLiveStats(shipId) != null;
}

/** Roman-numeral tier ("X", "★" for superships) or null for unknown tiers. */
export function tierRoman(tier: number | null | undefined): string | null {
  if (tier == null || !Number.isFinite(tier) || tier <= 0) return null;
  return tierToRoman(tier);
}

function hasMsg(key: string): boolean {
  // te() on the full message schema explodes type instantiation — go loose.
  return (i18n.global as { te: (k: string) => boolean }).te(key);
}

/** Localized ship-class label ("战列舰") with a raw-code fallback. */
export function shipTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  const key = `ships.type.${type}`;
  return hasMsg(key) ? t(key) : type;
}

/** WG long type → the battle-HUD short code (BB / CA / DD / CV / SS). */
const TYPE_SHORT: Record<string, string> = {
  Battleship: "BB",
  Cruiser: "CA",
  Destroyer: "DD",
  AirCarrier: "CV",
  Submarine: "SS",
  Auxiliary: "AX",
};

export function shipTypeShort(type: string | null | undefined): string | null {
  if (!type) return null;
  return TYPE_SHORT[type] ?? "?";
}

/** Localized consumable-slot label for a GameParams ability family. */
const CONSUMABLE_KEY: Record<string, string> = {
  CrashCrew: "crashCrew",
  RegenCrew: "regenCrew",
  Spotter: "spotter",
  Fighter: "fighter",
  SmokeGenerator: "smoke",
  SpeedBooster: "speedBoost",
  SonarSearch: "hydro",
  RLSSearch: "radar",
  Hydrophone: "hydrophone",
  SubmarineLocator: "subLocator",
  TorpedoReloader: "torpReload",
  ArtilleryBooster: "artyReload",
  AuxiliaryTorpedoArmamentBooster: "defensiveAA",
};

export function isKnownConsumable(family: string): boolean {
  return CONSUMABLE_KEY[family] != null;
}

/** Families worth a row badge: everything mapped EXCEPT the damage-control
 *  party, which every ship in the game carries — badging it would be noise
 *  (the hover card still lists it). */
export function isBadgeConsumable(family: string): boolean {
  return family !== "CrashCrew" && isKnownConsumable(family);
}

export function shipConsumableLabel(family: string): string {
  const code = CONSUMABLE_KEY[family];
  if (code) {
    const key = `ships.consumable.${code}`;
    if (hasMsg(key)) return t(key);
  }
  // Unmapped families stay readable (Halloween specials etc.) instead of
  // collapsing onto a wrong label.
  return family.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Researchable-module label for a baked `upg` kind code. The four classic
 *  kinds reuse the spec/compare wording the app already ships; the rest live
 *  under `ships.module.*`. */
const UPGRADE_KEY: Record<string, string> = {
  hull: "ships.compare.group.hull",
  artillery: "ships.spec.group.artillery",
  torpedoes: "ships.spec.group.torpedoes",
  engine: "ships.detail.weapon.engine",
  fireControl: "ships.module.fireControl",
  sonar: "ships.module.sonar",
  fighter: "ships.module.fighter",
  diveBomber: "ships.module.diveBomber",
  torpedoBomber: "ships.module.torpedoBomber",
  skipBomber: "ships.module.skipBomber",
  flightControl: "ships.module.flightControl",
};

export function shipUpgradeLabel(code: string): string {
  const key = UPGRADE_KEY[code] ?? `ships.module.${code}`;
  return hasMsg(key) ? t(key) : code;
}

/** AA band display order (near → far). */
export const AA_BAND_ORDER = ["near", "medium", "far"] as const;

/** One formatted chip in the parameter strip. */
export interface ShipParamChip {
  /** i18n short label (replay.live.param.*). */
  label: string;
  value: string;
  /** data-hint hover text (ships.spec.* long label + value). */
  hint: string;
}

function fmtKm(v: number): string {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}km`;
}

/**
 * The combat-relevant parameter chips for the row strip, in display order:
 * main-gun range, secondary range, torpedo range, ASW-airstrike range, the
 * outermost AA band, surface concealment, top speed. Chips without data are
 * skipped (a destroyer has no secondary range; a submarine no AA band).
 */
export function formatShipParams(s: ShipLiveStats): ShipParamChip[] {
  const chips: ShipParamChip[] = [];
  const push = (param: string, spec: string, value: string) =>
    chips.push({ label: t(`replay.live.param.${param}`), value, hint: `${t(spec)}: ${value}` });
  if (s.main) push("mainGun", "ships.spec.mainGunRange", fmtKm(s.main));
  if (s.sec) push("secondary", "ships.spec.secondaryRange", fmtKm(s.sec));
  if (s.torp) push("torpedo", "ships.spec.torpRange", fmtKm(s.torp));
  if (s.asw) push("airstrike", "ships.spec.aswRange", fmtKm(s.asw.r));
  if (s.aa) {
    const outer = AA_BAND_ORDER.map((b) => s.aa?.[b])
      .filter((b): b is NonNullable<AaBands[keyof AaBands]> => b != null)
      .pop();
    if (outer) {
      const km = fmtKm(outer.r);
      const dps = `${outer.dps}`;
      push("aa", "ships.spec.aaLongRange", `${km} · ${dps}`);
    }
  }
  if (s.det) push("concealment", "ships.spec.surfaceDetect", fmtKm(s.det));
  if (s.spd) push("speed", "ships.spec.maxSpeed", `${s.spd}kn`);
  return chips;
}

/**
 * Full parameter list for the hover card, grouped like 舰艇查询's spec tabs:
 * [groupLabel, rows[]] with rows as [label, value]. Same numbers as the strip
 * plus the fields too heavy for a row (HP, ASW charges/reload, every AA band,
 * air detectability). Purely derived from the baked record.
 */
export function formatShipSpecGroups(s: ShipLiveStats): Array<[string, Array<[string, string]>]> {
  const groups: Array<[string, Array<[string, string]>]> = [];
  const spec = (k: string) => t(`ships.spec.${k}`);
  const km = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)} km`;

  const surv: Array<[string, string]> = [];
  if (s.hp) surv.push([spec("hp"), s.hp.toLocaleString()]);
  if (surv.length) groups.push([t("ships.spec.group.survivability"), surv]);

  const art: Array<[string, string]> = [];
  if (s.main) art.push([spec("mainGunRange"), km(s.main)]);
  if (s.sec) art.push([spec("secondaryRange"), km(s.sec)]);
  if (art.length) groups.push([t("ships.spec.group.artillery"), art]);

  if (s.torp) groups.push([t("ships.spec.group.torpedoes"), [[spec("torpRange"), km(s.torp)]]]);

  const aa: Array<[string, string]> = [];
  for (const band of AA_BAND_ORDER) {
    const b = s.aa?.[band];
    if (!b) continue;
    const label =
      band === "near" ? spec("aaShortRange") : band === "medium" ? spec("aaMidRange") : spec("aaLongRange");
    aa.push([label, `${km(b.r)} · ${b.dps}`]);
  }
  if (aa.length) groups.push([t("ships.spec.group.antiAir"), aa]);

  if (s.asw) {
    const asw: Array<[string, string]> = [[spec("aswRange"), km(s.asw.r)]];
    if (s.asw.n) asw.push([spec("aswCharges"), String(s.asw.n)]);
    if (s.asw.t) asw.push([spec("aswReload"), `${s.asw.t} s`]);
    groups.push([t("ships.compare.group.asw"), asw]);
  }

  const mob: Array<[string, string]> = [];
  if (s.spd) mob.push([spec("maxSpeed"), `${s.spd} kn`]);
  if (mob.length) groups.push([t("ships.spec.group.mobility"), mob]);

  const con: Array<[string, string]> = [];
  if (s.det) con.push([spec("surfaceDetect"), km(s.det)]);
  if (s.detAir) con.push([spec("airDetect"), km(s.detAir)]);
  if (con.length) groups.push([t("ships.spec.group.concealment"), con]);

  return groups;
}
