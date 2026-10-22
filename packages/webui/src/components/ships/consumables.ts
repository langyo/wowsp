/**
 * Consumables card extraction for the ship-detail specs tab.
 *
 * The SLOT LAYOUT comes from the raw GameParams slice the modal already
 * unpacks (`ShipAbilities`: ordered slots, each listing the mountable
 * `[abilityEntity, variant]` alternatives — build-fresh). Everything ABOUT
 * each ability entity — per-variant charges, duration/cooldown, localized
 * names/descriptions, icon art — lives in the FULL GameParams the slice is
 * cut from, so `scripts/extract/build_consumable_details.py` snapshots it
 * into `src/data/consumable_details.json` (baked; keyed entity + variant).
 * This module joins the two: one slot group per non-special AbilitySlot,
 * one entry per mountable alternative.
 *
 * The default battle keys follow the game's consumable-slot sequence
 * (slot 1..5 → R/T/Y/U/I, per the official controls chart); slots beyond
 * the sequence and variants that auto-trigger (CV damage control / fighter
 * auto-consumables) carry no key. Localized names/descriptions follow the
 * 素材翻译 data language (the same {en,ja,zh,tw} dict convention as
 * signals.json — see BuildPlanner.dataText), falling back to English and
 * then the family label.
 */
import { t } from "@/i18n";
import type { HintCard, HintCardRow } from "@/composables/globalTooltip";
import { shipConsumableLabel } from "@/features/replay/shipLiveStats";
import detailsRaw from "../../data/consumable_details.json";

interface ConsumableStrings {
  names?: Record<string, string>;
  desc?: Record<string, string>;
}

interface ConsumableVariant {
  /** Strings key for the display name (and the desc, unless `d` differs). */
  t: string;
  /** Desc-only strings key, present when it differs from `t`. */
  d?: string;
  /** Charges; -1 = unlimited (the GameParams "missing → TimeBased" case). */
  c: number;
  /** Active duration (s), present when > 0. */
  w?: number;
  /** Cooldown (s), present when > 0. */
  r?: number;
  /** logic distShip (m) — hydro/sonar ship & radar detection range. */
  ds?: number;
  /** logic distTorpedo (m) — hydro/sonar torpedo detection range. */
  dt?: number;
  /** logic radius (m) — smoke-screen cloud or fighter patrol area. */
  rad?: number;
  /** defaultActivationMode == AUTO (no manual key). */
  a?: number;
}

interface ConsumableEntity {
  family: string;
  /** Webp stem under res/images/consumables/ ("" = none found at bake;
   *  absent entirely under a --no-icons bake). */
  icon?: string;
  variants: Record<string, ConsumableVariant>;
}

const DETAILS = detailsRaw as {
  strings: Record<string, ConsumableStrings>;
  entities: Record<string, ConsumableEntity>;
};

/** Icon URL per baked webp stem (Vite emits the paths at build time). */
const ICON_URLS = import.meta.glob<string>(
  "../../res/images/consumables/*.webp",
  { eager: true, query: "?url", import: "default" },
);

/** family → icon stem: the first entity of the family that baked one. */
const FAMILY_ICON = new Map<string, string>();
for (const rec of Object.values(DETAILS.entities)) {
  if (rec.icon && !FAMILY_ICON.has(rec.family)) FAMILY_ICON.set(rec.family, rec.icon);
}

export type ConsumableTone =
  | "default"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";

/** Purpose → accent tone of the name pill. Prefix rules (first match wins)
 *  so suffixed clones (…Premium_TimeBased, …_PVP, …_FA2022) inherit their
 *  family's color; unknown/event families fall back to the neutral tone. */
const TONE_RULES: Array<[prefix: string, tone: ConsumableTone]> = [
  ["CrashCrew", "danger"],
  ["RegenCrew", "success"],
  ["Fighter", "success"],
  ["Spotter", "primary"],
  ["RLSSearch", "warning"],
  ["SonarSearch", "info"],
  ["Hydrophone", "info"],
  ["SubmarineLocator", "info"],
  ["AuxiliaryTorpedoArmamentBooster", "danger"],
  ["SmokeGenerator", "default"],
  ["SpeedBooster", "primary"],
  ["TorpedoReloader", "primary"],
  ["ArtilleryBooster", "warning"],
];

export function consumableTone(family: string): ConsumableTone {
  for (const [prefix, tone] of TONE_RULES) {
    if (family.startsWith(prefix)) return tone;
  }
  return "default";
}

/** WG API locale code → the short code baked {names,desc} dicts use
 *  (same mapping BuildPlanner applies to signals/modernizations). */
export function dataCodeOf(dataLanguage: string): string {
  if (dataLanguage === "zh-CN" || dataLanguage === "zh-SG") return "zh";
  if (dataLanguage === "zh-TW") return "tw";
  if (dataLanguage === "ja-JP") return "ja";
  return "en";
}

function dataText(
  dict: Record<string, string> | undefined,
  code: string,
  fallback: string,
): string {
  if (!dict) return fallback;
  return dict[code] || dict.en || fallback;
}

export interface ConsumableEntry {
  entity: string;
  variant: string;
  family: string;
  tone: ConsumableTone;
  /** Display name (data language, en → family label fallbacks). */
  name: string;
  /** In-game description text, "" when the bake found none. */
  desc: string;
  /** Charges; -1 = unlimited. */
  charges: number;
  /** Active duration (s), null when unknown. */
  work: number | null;
  /** Cooldown (s), null when unknown. */
  reload: number | null;
  /** Hydro/sonar ship & radar detection range (m), null when N/A. */
  distShip: number | null;
  /** Hydro/sonar torpedo detection range (m), null when N/A. */
  distTorpedo: number | null;
  /** Smoke-screen cloud or fighter patrol radius (m), null when N/A. */
  radius: number | null;
  /** Auto-triggered (CV auto damage control / fighters) — no battle key. */
  auto: boolean;
  iconUrl: string | null;
}

export interface ConsumableSlotGroup {
  /** 0-based AbilitySlot index (the game's consumable slot number − 1). */
  slot: number;
  /** Default battle key for the slot, null beyond R/T/Y/U/I or when every
   *  alternative auto-triggers. */
  key: string | null;
  entries: ConsumableEntry[];
}

/** The game's default consumable-slot battle keys (slot 1..5). */
export const SLOT_KEYS = ["R", "T", "Y", "U", "I"] as const;

function resolveEntry(
  entity: string,
  variant: string,
  code: string,
): ConsumableEntry | null {
  const rec = DETAILS.entities[entity];
  if (!rec) return null;
  // Fake variants never made it into the bake — an unresolvable pair (a
  // client build the bake predates) drops the entry rather than lying.
  const spec = rec.variants[variant];
  if (!spec) return null;
  const strings = DETAILS.strings[spec.t];
  const descStrings = spec.d ? DETAILS.strings[spec.d] : strings;
  const familyLabel = shipConsumableLabel(rec.family);
  const iconStem = rec.icon || FAMILY_ICON.get(rec.family);
  return {
    entity,
    variant,
    family: rec.family,
    tone: consumableTone(rec.family),
    name: dataText(strings?.names, code, familyLabel || entity),
    desc: dataText(descStrings?.desc, code, ""),
    charges: spec.c,
    work: spec.w ?? null,
    reload: spec.r ?? null,
    distShip: spec.ds ?? null,
    distTorpedo: spec.dt ?? null,
    radius: spec.rad ?? null,
    auto: spec.a === 1,
    iconUrl: iconStem ? ICON_URLS[`../../res/images/consumables/${iconStem}.webp`] ?? null : null,
  };
}

/**
 * One group per non-special AbilitySlot carrying at least one resolvable
 * alternative, in slot order. The key rides the SLOT index (empty slots in
 * between keep their letter) and is withheld when every alternative
 * auto-triggers.
 */
export function buildConsumableSlots(
  gameparams: unknown,
  dataLanguage: string,
): ConsumableSlotGroup[] {
  if (!gameparams || typeof gameparams !== "object") return [];
  const abilities = (gameparams as Record<string, unknown>).ShipAbilities;
  if (!abilities || typeof abilities !== "object") return [];
  const code = dataCodeOf(dataLanguage);
  const groups: ConsumableSlotGroup[] = [];
  for (const [name, raw] of Object.entries(abilities as Record<string, unknown>)) {
    if (!/^AbilitySlot/.test(name)) continue;
    if (!raw || typeof raw !== "object") continue;
    const slotDef = raw as Record<string, unknown>;
    if (slotDef.isSpecial) continue;
    const slot = typeof slotDef.slot === "number" ? slotDef.slot : Number(slotDef.slot);
    if (!Number.isFinite(slot)) continue;
    const abils = Array.isArray(slotDef.abils) ? slotDef.abils : [];
    const entries: ConsumableEntry[] = [];
    for (const pair of abils) {
      if (!Array.isArray(pair)) continue;
      const [entity, variant] = pair;
      if (typeof entity !== "string" || typeof variant !== "string") continue;
      const entry = resolveEntry(entity, variant, code);
      if (entry) entries.push(entry);
    }
    if (entries.length === 0) continue;
    const key =
      slot >= 0 && slot < SLOT_KEYS.length && entries.some((e) => !e.auto)
        ? SLOT_KEYS[slot]
        : null;
    groups.push({ slot, key, entries });
  }
  groups.sort((a, b) => a.slot - b.slot);
  return groups;
}

function fmtSecs(v: number): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${s} s`;
}

/** Metres → "5.9 km"; whole kilometres drop the decimals. */
function fmtKm(v: number): string {
  const km = v / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}

/** Structured hover-card payload for an entry (pre-localized; the global
 *  tooltip renders it via `data-hint-card`). */
export function consumableHintCard(
  entry: ConsumableEntry,
  group: ConsumableSlotGroup,
): HintCard {
  const rows: HintCardRow[] = [
    {
      label: t("ships.spec.consumables.charges"),
      value:
        entry.charges < 0
          ? t("ships.spec.consumables.unlimited")
          : `× ${entry.charges}`,
    },
  ];
  if (entry.work != null)
    rows.push({ label: t("ships.spec.consumables.workTime"), value: fmtSecs(entry.work) });
  // Effective ranges: hydro/sonar quote ship and torpedo detection as a
  // pair, radar-style single distances quote the plain label, smoke quotes
  // its screen radius — each only when the bake found the field.
  if (entry.distShip != null && entry.distTorpedo != null) {
    rows.push({ label: t("ships.spec.consumables.rangeShip"), value: fmtKm(entry.distShip) });
    rows.push({ label: t("ships.spec.consumables.rangeTorpedo"), value: fmtKm(entry.distTorpedo) });
  } else if (entry.distShip != null) {
    rows.push({ label: t("ships.spec.consumables.range"), value: fmtKm(entry.distShip) });
  }
  if (entry.radius != null) {
    // The same logic.radius field means different things per family: smoke
    // screens quote their cloud's radius, fighter consumables quote the
    // patrol radius their squadron holds.
    rows.push({
      label: t(
        entry.family.startsWith("Fighter")
          ? "ships.spec.consumables.patrolRadius"
          : "ships.spec.consumables.radius",
      ),
      value: fmtKm(entry.radius),
    });
  }
  if (entry.reload != null)
    rows.push({ label: t("ships.spec.consumables.reloadTime"), value: fmtSecs(entry.reload) });
  // Identity line: slot position, then the auto marker and the family label
  // — both only when they add something the title doesn't already say (the
  // game name of a mapped family IS the family label; unmapped families and
  // fallback names would otherwise duplicate it).
  const familyLabel = shipConsumableLabel(entry.family);
  const subtitle = [
    t("ships.spec.consumables.slotLabel", { n: group.slot + 1 }),
    entry.auto ? t("ships.spec.consumables.auto") : "",
    familyLabel !== entry.name ? familyLabel : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    title: entry.name,
    badge: entry.auto ? undefined : (group.key ?? undefined),
    iconUrl: entry.iconUrl ?? undefined,
    subtitle,
    rows,
    note: entry.desc || undefined,
  };
}
