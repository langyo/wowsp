import { computed, defineComponent, onScopeDispose, ref, Teleport, watch, type PropType } from "vue";
import { Ban, Coins, Lock, RotateCcw } from "@lucide/vue";

import { HButton } from "@celestia-island/hikari";
import { i18n, t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { AssetImage } from "@/components/base/AssetImage";
import { techTreeNode } from "@/utils/techTreeData";
import type { ShipInfo } from "@/api";
import {
  classSkills,
  recommendedSkills,
  SKILL_BUDGET,
  TIER_UNLOCK,
  skillClassFor,
  skillIconUrl,
  skillUnavailable,
  type Skill,
  type SkillRequirement,
} from "./skillTree";
import { type PlannerBuild } from "./modifierPipeline";
import { cxpForPoints, priceOf, retrainCredits } from "./costs";
import { api, type UpgradePrice } from "@/api";
import DataObserver from "./DataObserver";
import signalsData from "../../data/signals.json";
import modernizationsData from "../../data/modernizations.json";
import commandersData from "../../data/commanders.json";
import shipConsumablesData from "../../data/ship_consumables.json";
import "./BuildPlanner.scss";

/**
 * Ship build planner — the captain-skills tab, reworked as a 3-pane layout:
 *   Left rail:  4 icon buttons (skills / commanders / signals / upgrades)
 *               switching the center section.
 *   Center:     the active section's content.
 *   Right:      综合属性 stats panel (DataObserver) with the current-HP
 *               slider pinned on top (drives Adrenaline-Rush-style triggers).
 * The points bar spans above all three panes.
 *
 * Build state lives in the parent (ShipDetailModal) so it survives tab
 * switches and resets when the ship changes.
 */

// ── Asset resolvers (real in-game art under src/res/images) ──────────────
// import.meta.glob needs literal patterns, so each art class is globbed at
// module scope and mapped lowercase-stem → real filename stem.
function stemMapOf(paths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of paths) {
    const file = path.split("/").pop()!;
    const stem = file.replace(/\.(webp|png)$/i, "");
    map.set(stem.toLowerCase(), stem);
  }
  return map;
}
const COMMANDER_STEMS = stemMapOf(
  Object.keys(import.meta.glob("../../res/images/commanders/*.{webp,png}")),
);
const SIGNAL_STEMS = stemMapOf(
  Object.keys(import.meta.glob("../../res/images/signals/*.{webp,png}")),
);
const MODERNIZATION_STEMS = stemMapOf(
  Object.keys(import.meta.glob("../../res/images/modernization/*.{webp,png}")),
);

function commanderIconUrl(portrait: string | undefined): string | null {
  if (!portrait) return null;
  const stem = portrait.replace(/\.(webp|png)$/i, "");
  const real = COMMANDER_STEMS.get(stem.toLowerCase());
  return real ? `/images/commanders/${real}.webp` : null;
}
function signalIconUrl(name: string): string | null {
  const real = SIGNAL_STEMS.get(name.toLowerCase());
  return real ? `/images/signals/${real}.webp` : null;
}
function modernizationIconUrl(name: string): string | null {
  const real = MODERNIZATION_STEMS.get(`icon_modernization_${name}`.toLowerCase());
  // The glob stems already carry the icon_modernization_ prefix.
  return real ? `/images/modernization/${real}.webp` : null;
}

// ── Data shapes (subsets of the extracted JSONs) ──────────────────────────
interface SignalEntry {
  index: string;
  name: string;
  names: Record<string, string>;
  desc: Record<string, string>;
  sortOrder: number;
  /** Effect coefficients — scalars or per-class dicts keyed by WG class. */
  modifiers: Record<string, unknown>;
}
interface ModernizationEntry {
  name: string;
  names: Record<string, string>;
  desc: Record<string, string>;
  slot: number;
  shiptype: string[];
  nation: string[];
  shiplevel: number[];
  /** Optional ship-gating: full GameParams names ("PJSB018_Yamato_1944");
   *  a mod is mountable only when one name's leading token (before the
   *  first "_") matches the ship's tech-tree index. */
  ships?: string[];
  /** Optional rarity tags ("unique" = research-bureau gear). */
  tags?: string[];
}
interface CommanderTalent {
  activatorType: string;
  maxTriggerNum: number;
  actions: Array<{
    base: Record<string, unknown>;
    levels: Record<string, Record<string, unknown>>;
  }>;
}
interface CommanderEntry {
  name: string;
  person: string;
  nations: string[];
  portrait?: string;
  talents: CommanderTalent[];
  /** Skill codes this captain teaches at enhanced ("epic") values — the
   *  green corner ribbon on the skill tree. */
  epicSkills?: string[];
}

/** One rendered line of the flag hover card. */
interface FlagEffect {
  key: string;
  label: string;
  text: string;
  good: boolean;
}

const SIGNALS = (signalsData as SignalEntry[]).slice().sort((a, b) => a.sortOrder - b.sortOrder);
const MODERNIZATIONS = modernizationsData as ModernizationEntry[];
const COMMANDERS = (commandersData as CommanderEntry[])
  .slice()
  .sort((a, b) => (b.talents.length > 0 ? 1 : 0) - (a.talents.length > 0 ? 1 : 0) || a.person.localeCompare(b.person));
/** Tech-tree index → consumable ability families (Spotter / Fighter / …)
 *  extracted from GameParams ShipAbilities (the WG API hides loadouts);
 *  backs the consumable-gated skill bans. */
const SHIP_CONSUMABLES = shipConsumablesData as Record<string, string[]>;

/** WG lowercase nation code → GameParams nation name used by modernizations. */
const GP_NATION: Record<string, string> = {
  usa: "USA",
  japan: "Japan",
  germany: "Germany",
  uk: "United_Kingdom",
  ussr: "Russia",
  france: "France",
  italy: "Italy",
  netherlands: "Netherlands",
  spain: "Spain",
  pan_asia: "Pan_Asia",
  pan_america: "Pan_America",
  commonwealth: "Commonwealth",
  europe: "Europe",
  // WG mixes both spellings for the pan-European faction (tech tree ships
  // carry "pan_europe", GameParams mods/commanders say "Europe").
  pan_europe: "Europe",
  // ship_names.json keeps the raw game-file spellings; synthetic ShipInfo
  // entries (event ships outside the encyclopedia) carry them verbatim.
  united_kingdom: "United_Kingdom",
  russia: "Russia",
};

/** skilltree.json / signals.json / modernizations.json language key for the
 *  current data-language setting (falls back to en). */
const DATA_KEY_BY_LANG: Record<string, string> = {
  "zh-CN": "zh",
  "zh-SG": "zh",
  "zh-TW": "tw",
  "ja-JP": "ja",
  "en-US": "en",
};

/** Signal modifier keys where BELOW 1 is the player-friendly side (reload
 *  times, burn/flood durations, dispersion...); every unlisted key is
 *  higher-is-better — including GSMaxDist, which is secondary-battery
 *  RANGE (MY6 carries it at 1.05 = +5% range). Drives the green/red
 *  coloring of the flag hover card. */
const LOWER_IS_BETTER_EFFECTS = new Set([
  "ConsumableReloadTime",
  "auxTorpBoosterReloadCoeff",
  "GSIdealRadius",
  "GSShotDelay",
  "burnTime",
  "collisionDamageNerf",
  "floodTime",
  "hydrophoneReloadCoeff",
  "planeConsumableReloadTime",
  "submarineLocatorReloadCoeff",
]);

/** Additive percentage-point signal modifiers (0.01 = +1pp), not
 *  multipliers — formatted (and signed) differently from coefficients. */
const PP_EFFECTS = new Set(["burnChanceFactorBig", "burnChanceFactorSmall"]);

/** Commander-talent modifier keys that are activation plumbing, never
 *  player-visible stats — dropped from the talent rows entirely.
 *  GSMShotDelay is data-dead too: 1.0 in every dict, duplicating the
 *  GSShotDelay row's label as "±0%". */
const TALENT_HIDDEN_KEYS = new Set([
  "useShipTierAsWorkTime",
  "scaleRegenWithShipTier",
  "ignoreRegenLimit",
  "rageModeFloorLevel",
  "GSMShotDelay",
]);
/** +N consumable-charge keys (additive counts, not multipliers). */
const TALENT_COUNT_KEYS = new Set([
  "additionalConsumables",
  "planeAdditionalConsumables",
  "torpedoReloaderAdditionalConsumables",
]);
/** Percent-of-max-HP-per-second regen keys (0.000417 = 0.04%/s). */
const TALENT_RATE_KEYS = new Set(["regenerationHPSpeed"]);
/** Flat per-second HP keys (300 = 300 HP/s), rendered as a bare number. */
const TALENT_UNIT_KEYS = new Set(["regenerationHPSpeedUnits"]);
/** Duration keys, rendered in seconds. */
const TALENT_SECOND_KEYS = new Set(["workTime"]);
/** Additive percentage-point talent keys (0.01 = +1pp). */
const TALENT_POINTS_KEYS = new Set(["burnChanceBonus"]);

/** Mod families whose GameParams ships-list is a WHITELIST despite carrying
 *  a type restriction like exclusion-listing regulars. GameParams has no
 *  explicit marker — the store semantics are known per family: skip bombers
 *  only exist on the six hybrid-art carriers (PCM081/092_SkipBomber_Mod_I). */
const SHIPS_WHITELIST_FAMILIES = /_SkipBomber_Mod_/;

/** i18n key exists? (avoids vue-i18n fallback warnings for data-driven keys) */
function hasMsg(key: string): boolean {
  // te() on the full message schema explodes type instantiation — go loose.
  return (i18n.global as { te: (k: string) => boolean }).te(key);
}

type Section = "skills" | "captains" | "flags" | "upgrades" | "costs";

export default defineComponent({
  name: "BuildPlanner",
  props: {
    ship: { type: Object as PropType<ShipInfo>, required: true },
    build: { type: Object as PropType<PlannerBuild>, required: true },
    /** Install root — feeds the GameParams price walk for cost calc. */
    gameRoot: { type: String, default: "" },
  },
  emits: {
    "update:build": (_v: PlannerBuild) => true,
  },
  setup(props, { emit }) {
    const { dataLanguage } = useLanguage();
    const section = ref<Section>("skills");

    const dataLangKey = computed(() => DATA_KEY_BY_LANG[dataLanguage.value] ?? "en");

    function setBuild(patch: Partial<PlannerBuild>): void {
      emit("update:build", { ...props.build, ...patch });
    }

    /** Localized name/desc out of a data record ({en,ja,zh,tw} dict). */
    function dataText(dict: Record<string, string>, fallback: string): string {
      return dict?.[dataLangKey.value] || dict?.en || fallback;
    }

    // ── Top bar ────────────────────────────────────────────────────────────
    const usedPoints = computed(() => Object.keys(props.build.skills).length);
    const remaining = computed(() => SKILL_BUDGET - usedPoints.value);

    // ── Skills section ─────────────────────────────────────────────────────
    const cls = computed(() => skillClassFor(props.ship.type));
    const tree = computed(() => classSkills(cls.value));

    const tiers = computed(() => {
      const out: Record<number, Skill[]> = { 1: [], 2: [], 3: [], 4: [] };
      for (const s of tree.value) out[s.tier]?.push(s);
      for (const list of Object.values(out)) list.sort((a, b) => a.column - b.column);
      return out;
    });

    /** Column count of this class's tree = max(column) + 1 (BB/CA/DD/CV → 6,
     *  SS → 15). Fixed per class — not per tier — so tier rows stay aligned
     *  even where a tier has fewer skills (gaps render as placeholders). */
    const skillColumns = computed(() => {
      let n = 0;
      for (const s of tree.value) n = Math.max(n, s.column + 1);
      return n;
    });

    /** Consumable ability families of THIS hull, keyed by its tech-tree
     *  index; null when the hull is missing from ship_consumables.json —
     *  the consumable-skill gate then never bans (conservative). */
    const consumableFamilies = computed<ReadonlySet<string> | null>(() => {
      const idx = techTreeNode(props.ship.shipId)?.index;
      const fams = idx ? SHIP_CONSUMABLES[idx] : undefined;
      return fams ? new Set(fams) : null;
    });

    function skillBan(skill: Skill): SkillRequirement | null {
      return skillUnavailable(skill.code, props.ship.defaultProfile as Record<string, any> | null, consumableFamilies.value);
    }

    // A build restored against another hull may carry skills this ship can
    // no longer pick (no torpedo tubes, no AA…) — prune them out of the
    // build object itself so the points counter refunds them.
    watch(
      () => props.ship,
      () => {
        const skills = { ...props.build.skills };
        let pruned = false;
        for (const code of Object.keys(skills)) {
          if (skillUnavailable(code, props.ship.defaultProfile as Record<string, any> | null, consumableFamilies.value)) {
            delete skills[code];
            pruned = true;
          }
        }
        if (pruned) setBuild({ skills });
      },
      { immediate: true },
    );

    function pointsBelowTier(tier: number): number {
      return tree.value.filter((s) => s.tier < tier && props.build.skills[s.code]).length;
    }
    function tierUnlocked(tier: number): boolean {
      if (tier === 1) return true;
      return pointsBelowTier(tier) >= TIER_UNLOCK[tier as 2 | 3 | 4];
    }
    function toggleSkill(skill: Skill): void {
      if (props.build.skills[skill.code]) {
        const skills = { ...props.build.skills };
        delete skills[skill.code];
        setBuild({ skills });
      } else if (
        !skillBan(skill) &&
        remaining.value > 0 &&
        tierUnlocked(skill.tier)
      ) {
        setBuild({ skills: { ...props.build.skills, [skill.code]: 1 } });
      }
    }
    function skillName(skill: Skill): string {
      return dataText(skill.name, skill.code);
    }
    function skillHint(skill: Skill): string {
      const desc = skill.desc?.[dataLangKey.value] || skill.desc?.en || "";
      return desc.trim() ? desc : skillName(skill);
    }

    // ── Commanders section ─────────────────────────────────────────────────
    /** WG lowercase nation → GameParams nation of the current ship (drives
     *  both the commander pool and modernization gating). */
    const gpNation = computed(() => GP_NATION[props.ship.nation] ?? props.ship.nation);
    /** Commanders usable on THIS ship. Filtering by nation also drops the
     *  7 event-bound commanders (empty nations). COMMANDERS is pre-sorted
     *  legendary-first then by person — the filter preserves that order. */
    const shipCommanders = computed(() => COMMANDERS.filter((c) => c.nations.includes(gpNation.value)));
    function commanderDisplayName(cmd: CommanderEntry): string {
      const key = `ships.commanders.${cmd.person}`;
      return hasMsg(key) ? t(key) : cmd.person.replace(/_/g, " ");
    }
    function activatorLabel(type: string): string {
      const key = `ships.skills.activator.${type}`;
      return hasMsg(key) ? t(key) : type.replace(/Activator$/, "");
    }
    function toggleCommander(name: string): void {
      setBuild({ commander: props.build.commander === name ? null : name });
    }
    const selectedCommander = computed(() =>
      props.build.commander
        ? COMMANDERS.find((c) => c.name === props.build.commander) ?? null
        : null,
    );
    /** Skills the selected legendary captain teaches at enhanced ("epic")
     *  values, restricted to the current class tree — the green corner
     *  ribbon on the skill grid. */
    const epicSkills = computed(() => {
      const epic = selectedCommander.value?.epicSkills;
      if (!epic?.length) return new Set<string>();
      const codes = new Set(tree.value.map((s) => s.code));
      return new Set(epic.filter((c) => codes.has(c)));
    });
    /** Skills the game itself recommends for THIS ship (crew-presets table,
     *  most specific of exact ship / group / class) — the amber corner
     *  ribbon. */
    const recommended = computed(() =>
      recommendedSkills(techTreeNode(props.ship.shipId)?.index ?? null, props.ship.type),
    );
    /** Numeric key:value pairs of one modifier dict, with plain keys hidden
     *  when their *UI twin is present, internal enums and activation
     *  plumbing (tier-scaling / regen-cap switches, the dead GSMShotDelay)
     *  dropped, and zero-valued count / rate / duration plumbing (e.g. the
     *  "0s" on a tier-scaled duration) skipped. */
    function kvOf(dict: Record<string, unknown>): Array<[string, number]> {
      const kv: Array<[string, number]> = [];
      for (const [k, v] of Object.entries(dict ?? {})) {
        if (typeof v !== "number" || k === "uniqueType") continue;
        if (TALENT_HIDDEN_KEYS.has(k)) continue;
        if (
          v === 0 &&
          (TALENT_COUNT_KEYS.has(k) ||
            TALENT_RATE_KEYS.has(k) ||
            TALENT_UNIT_KEYS.has(k) ||
            TALENT_SECOND_KEYS.has(k))
        )
          continue;
        if (!k.endsWith("UI") && `${k}UI` in dict) continue; // UI twin wins
        kv.push([k, v]);
      }
      return kv.sort((a, b) => a[0].localeCompare(b[0]));
    }
    /** One talent's level rows: level → numeric key:value pairs. Talents
     *  without per-level data (most of them) fall back to their base block. */
    function talentRows(talent: CommanderTalent): Array<{ level: string; kv: Array<[string, number]> }> {
      const rows: Array<{ level: string; kv: Array<[string, number]> }> = [];
      for (const action of talent.actions ?? []) {
        for (const level of Object.keys(action.levels ?? {}).sort((a, b) => Number(a) - Number(b))) {
          const kv = kvOf(action.levels[level]);
          if (kv.length > 0) rows.push({ level, kv });
        }
      }
      if (rows.length === 0) {
        const base = kvOf(talent.actions?.[0]?.base ?? {});
        if (base.length > 0) rows.push({ level: "·", kv: base });
      }
      return rows;
    }
    /** Value text per key semantics: multipliers (the common case) read as
     *  signed percent of (v−1); consumable-charge keys are additive counts;
     *  regen rates are percent of max HP per second; durations are seconds. */
    function fmtTalentValue(k: string, v: number): string {
      if (TALENT_COUNT_KEYS.has(k)) return `+${v}`;
      if (TALENT_SECOND_KEYS.has(k)) return `${v}s`;
      if (TALENT_UNIT_KEYS.has(k)) return String(v);
      if (TALENT_RATE_KEYS.has(k)) {
        const pct = (v * 100).toFixed(2).replace(/\.?0+$/, "");
        return `${pct}%`;
      }
      if (TALENT_POINTS_KEYS.has(k)) return signedPct(v * 100);
      return signedPct((v - 1) * 100);
    }
    /** Catalog label for a talent modifier key (ships.talent.effect.*), or
     *  the raw key when the catalog has no entry for it. */
    function talentEffectLabel(k: string): string {
      const key = `ships.talent.effect.${k}`;
      return hasMsg(key) ? t(key) : k;
    }

    // ── Signals section ────────────────────────────────────────────────────
    function signalName(sig: SignalEntry): string {
      const key = `ships.signals.${sig.index}`;
      return hasMsg(key) ? t(key) : dataText(sig.names, sig.index);
    }
    function toggleSignal(index: string): void {
      const cur = props.build.signals;
      setBuild({
        signals: cur.includes(index) ? cur.filter((s) => s !== index) : [...cur, index],
      });
    }

    // ── Flag hover card (game-style rich tooltip) ──────────────────────────
    // data-hint is text-only, so the name + flavor + per-modifier breakdown
    // rides a custom fixed card anchored under the hovered tile.
    const flagTip = ref<{ sig: SignalEntry; cx: number; bottom: number } | null>(null);
    const flagTipEl = ref<HTMLElement | null>(null);
    const flagTipPos = ref<Record<string, string>>({ left: "0px", top: "0px", visibility: "hidden" });

    function hideFlagTip(): void {
      flagTip.value = null;
      window.removeEventListener("scroll", hideFlagTip, true);
    }
    function showFlagTip(sig: SignalEntry, el: HTMLElement): void {
      const r = el.getBoundingClientRect();
      flagTip.value = { sig, cx: r.left + r.width / 2, bottom: r.bottom };
      // Any scroll (capture: the modal body scrolls, not the window) moves a
      // fixed card off its anchor — hide, same trade the global hint makes.
      window.addEventListener("scroll", hideFlagTip, true);
    }
    // Measure the card after it mounts, then clamp into the viewport —
    // flipped above the tile when there is no room below.
    watch(
      flagTip,
      () => {
        const el = flagTipEl.value;
        const tip = flagTip.value;
        if (!el || !tip) return;
        const card = el.getBoundingClientRect();
        const m = 8;
        const x = Math.max(m, Math.min(tip.cx - card.width / 2, window.innerWidth - card.width - m));
        let y = tip.bottom + 8;
        if (y + card.height > window.innerHeight - m) y = Math.max(m, tip.bottom - card.height - 8);
        flagTipPos.value = { left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, visibility: "visible" };
      },
      { flush: "post" },
    );
    watch(section, hideFlagTip);
    onScopeDispose(hideFlagTip);

    /** Signed percent text, game-style: "+5%" / "−5%" / "+0.5%". */
    function signedPct(v: number): string {
      if (v === 0) return "±0%";
      const abs = Number.isInteger(v) ? String(Math.abs(v)) : String(Number(Math.abs(v).toFixed(1)));
      return `${v > 0 ? "+" : "−"}${abs}%`;
    }
    /** Resolve one modifier value for THIS ship — per-class dicts resolve by
     *  the WG class name; a dict missing the ship's class means the effect
     *  does not apply to this ship (same rule as modifierPipeline), so the
     *  line is skipped rather than showing another class's number. */
    function effectValue(raw: unknown): number | null {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      if (raw && typeof raw === "object") {
        const own = (raw as Record<string, unknown>)[props.ship.type];
        if (typeof own === "number" && Number.isFinite(own)) return own;
      }
      return null;
    }
    /** One hover-card line per modifier: i18n label + signed value, colored
     *  green when beneficial / red when harmful (multiplicative keys show
     *  (v−1)·100, additive burn-chance keys show v·100). */
    function flagEffects(sig: SignalEntry): FlagEffect[] {
      const out: FlagEffect[] = [];
      for (const [key, raw] of Object.entries(sig.modifiers ?? {})) {
        const v = effectValue(raw);
        if (v == null) continue;
        const pp = PP_EFFECTS.has(key);
        const pct = pp ? v * 100 : (v - 1) * 100;
        const good = pp ? v > 0 : v !== 1 && (v > 1) !== LOWER_IS_BETTER_EFFECTS.has(key);
        out.push({ key, label: t(`ships.flags.effect.${key}`), text: signedPct(pct), good });
      }
      return out;
    }

    // ── Upgrades section ───────────────────────────────────────────────────
    /** Slot indexes unlocked by the ship's tier (WoWS wiki "Ship:Upgrades":
     *  slot 1 @ T1, 2 @ T3, 3 @ T5, 4 @ T6, 5 @ T8, 6 @ T9). */
    const shipSlots = computed<number[]>(() => {
      const t = props.ship.tier;
      const count =
        1 + (t >= 3 ? 1 : 0) + (t >= 5 ? 1 : 0) + (t >= 6 ? 1 : 0) + (t >= 8 ? 1 : 0) + (t >= 9 ? 1 : 0);
      return [0, 1, 2, 3, 4, 5].slice(0, count);
    });
    /** Ship-gating by GameParams `ships` (full ship names, matched by leading
     *  tech-tree index token). The semantics flip with the mod class:
     *  research-bureau unique mods WHITELIST their ships (Yamato's unique
     *  upgrade lists Yamato), and so does every entry with NO type
     *  restriction — the low-tier Aiming Systems Mod 0 names exactly the
     *  three ships that may mount it. Only broadly-typed regular mods carry
     *  EXCLUSION lists (Main Gun Mod 3 names the submarines it must not be
     *  mounted on), so reading those as whitelists would gut the tab —
     *  with one exception: the skip-bomber mods are typed like regular CV
     *  upgrades but their six-ship list is a whitelist (the game mounts
     *  them on exactly those hybrid-art carriers). */
    function shipMatches(m: ModernizationEntry): boolean {
      if (!m.ships?.length) return true;
      const index = techTreeNode(props.ship.shipId)?.index ?? null;
      const hit = index != null && m.ships.some((s) => s.split("_")[0] === index);
      const whitelist =
        m.tags?.includes("unique") ||
        m.shiptype.length === 0 ||
        SHIPS_WHITELIST_FAMILIES.test(m.name);
      return whitelist ? hit : !hit;
    }
    function upgradesForSlot(slot: number): ModernizationEntry[] {
      return MODERNIZATIONS.filter((m) => {
        if (m.slot !== slot) return false;
        // Dead catalog: an entry with no type restriction AND no ship binding
        // is a legacy upgrade the current game sells nowhere — the unnamed
        // PCM001_MainGun_Mod_I family plus the named-but-obsolete
        // 防御型对空火力修改型1 (PCM040) and sub Steering Gear Mod 3 (PCM091).
        if (m.shiptype.length === 0 && !m.ships?.length) return false;
        return (
          (m.shiptype.length === 0 || m.shiptype.includes(props.ship.type)) &&
          (m.nation.length === 0 || m.nation.includes(gpNation.value)) &&
          (m.shiplevel.length === 0 || m.shiplevel.includes(props.ship.tier)) &&
          shipMatches(m)
        );
      });
    }
    function toggleUpgrade(slot: number, name: string): void {
      const upgrades = { ...props.build.upgrades };
      if (upgrades[slot] === name) delete upgrades[slot];
      else upgrades[slot] = name;
      setBuild({ upgrades });
    }

    // ── Cost panel data: GameParams price walk (loaded per game root,
    //    the first time the 成本计算 section opens) ──
    const prices = ref<Record<string, UpgradePrice> | null>(null);
    const pricesError = ref(false);
    let pricesLoadedFor = "";
    watch(
      () => [props.gameRoot, section.value] as const,
      ([root, sec]) => {
        if (sec !== "costs" || !root || pricesLoadedFor === root) return;
        pricesLoadedFor = root;
        api
          .getUpgradePrices(root)
          .then((p) => {
            prices.value = p;
            pricesError.value = false;
          })
          .catch(() => {
            pricesError.value = true;
          });
      },
      { immediate: true },
    );

    const RAIL: Array<{ key: Section; labelKey: string; icon?: string }> = [
      { key: "skills", labelKey: "tabSkills", icon: "/images/skills/gm_turn.webp" },
      { key: "captains", labelKey: "tabCaptains", icon: "/images/commanders/Yamamoto.webp" },
      { key: "flags", labelKey: "tabFlags", icon: "/images/signals/PCEF030_CK_SignalFlag.webp" },
      {
        key: "upgrades",
        labelKey: "tabUpgrades",
        icon: "/images/modernization/icon_modernization_PCM027_ConcealmentMeasures_Mod_I.webp",
      },
      // No game art exists for this pseudo-section — the rail renders a
      // lucide glyph for it instead (see the nav markup below).
      { key: "costs", labelKey: "tabCosts" },
    ];

    // ── Center-section renderers ───────────────────────────────────────────
    function renderSkills() {
      if (tree.value.length === 0) {
        return <p class="planner-v__empty">{t("ships.skills.noTree")}</p>;
      }
      const columns = skillColumns.value;
      const legend = (
        <div key="ribbon-legend">
          {epicSkills.value.size > 0 ? (
            <p class="planner-v__note">{t("ships.skills.epicLegend")}</p>
          ) : null}
          {recommended.value.size > 0 ? (
            <p class="planner-v__note">{t("ships.skills.recLegend")}</p>
          ) : null}
        </div>
      );
      const tierRows = [1, 2, 3, 4].map((tier) => {
        const unlocked = tierUnlocked(tier);
        const need = tier === 1 ? 0 : TIER_UNLOCK[tier as 2 | 3 | 4];
        // Dense column map — sparse tiers (DD tier-4, the SS tree) carry
        // intentional gaps that must hold their column position.
        const byColumn = new Map(tiers.value[tier].map((s) => [s.column, s]));
        const cells = [];
        for (let col = 0; col < columns; col++) {
          const skill = byColumn.get(col);
          if (!skill) {
            cells.push(
              <div class="skill-tile-v skill-tile-v--empty" key={`empty-${tier}-${col}`} />,
            );
            continue;
          }
          const picked = !!props.build.skills[skill.code];
          const banned = skillBan(skill);
          const enhanced = epicSkills.value.has(skill.code);
          const rec = recommended.value.has(skill.code);
          const name = skillName(skill);
          const hints = [
            skillHint(skill),
            enhanced ? t("ships.skills.epicRibbon") : "",
            rec ? t("ships.skills.recRibbon") : "",
          ].filter(Boolean);
          const hint = hints.join(" — ");
          cells.push(
            <div
              class={[
                "skill-tile-v",
                picked ? "skill-tile-v--active" : "",
                banned ? "skill-tile-v--banned" : "",
              ]}
              key={skill.code}
            >
              <button
                type="button"
                class="skill-tile-v__btn"
                disabled={!unlocked || !!banned}
                onClick={() => (unlocked && !banned ? toggleSkill(skill) : null)}
                data-hint={banned ? t("ships.skills.notApplicable") : hint}
              >
                <span class="skill-tile-v__icon">
                  <AssetImage
                    class="skill-tile-v__icon-img"
                    src={skillIconUrl(skill.code, cls.value)}
                    alt={name}
                    fallback={<span>{name.charAt(0)}</span>}
                  />
                </span>
              </button>
              {/* Sibling of the button so the active/banned filters never
                  wash the ribbon out. */}
              {enhanced ? (
                <span class="skill-tile-v__ribbon skill-tile-v__ribbon--epic" />
              ) : null}
              {rec ? (
                <span class="skill-tile-v__ribbon skill-tile-v__ribbon--rec" />
              ) : null}
              {banned ? (
                <span class="skill-tile-v__ban">
                  <Ban size={18} />
                </span>
              ) : null}
              <span class="skill-tile-v__name">{name}</span>
            </div>,
          );
        }
        return (
          <div class={["skill-tier-v", unlocked ? "" : "skill-tier-v--locked"]} key={tier}>
            <div class="skill-tier-v__label">
              <span>{t("ships.skills.tier", { n: tier })}</span>
              {!unlocked ? (
                <span class="skill-tier-v__lock" data-hint={t("ships.skills.locked", { n: need })}>
                  <Lock size={10} />
                </span>
              ) : null}
            </div>
            {/* Fixed column template per class — auto-fill let short rows
                drift out of alignment with the tier above. */}
            <div
              class="skill-tier-v__row"
              style={{ gridTemplateColumns: `repeat(${columns}, 56px)` }}
            >
              {cells}
            </div>
          </div>
        );
      });
      return legend ? [legend, ...tierRows] : tierRows;
    }

    function renderCommanders() {
      const selected = selectedCommander.value;
      const list = shipCommanders.value;
      return (
        <div class="planner-v__captains">
          <p class="planner-v__note">{t("ships.skills.commanderInfoNote")}</p>
          {list.length === 0 ? (
            <p class="planner-v__empty">{t("ships.skills.noCommandersForNation")}</p>
          ) : (
            <div class="planner-v__cmd-grid">
              {list.map((cmd) => {
                const active = props.build.commander === cmd.name;
                const legendary = cmd.talents.length > 0;
                return (
                  <button
                    type="button"
                    class={["planner-v__cmd", active ? "planner-v__cmd--active" : ""]}
                    key={cmd.name}
                    onClick={() => toggleCommander(cmd.name)}
                  >
                    <span class="planner-v__cmd-portrait">
                      <AssetImage
                        class="planner-v__cmd-img"
                        src={commanderIconUrl(cmd.portrait)}
                        alt={commanderDisplayName(cmd)}
                        fallback={<span>{commanderDisplayName(cmd).charAt(0)}</span>}
                      />
                    </span>
                    <span
                      class={[
                        "planner-v__cmd-rank",
                        legendary ? "planner-v__cmd-rank--legendary" : "",
                      ]}
                    >
                      {legendary ? t("ships.skills.legendaryCmd") : t("ships.skills.eliteCmd")}
                    </span>
                    <span class="planner-v__cmd-name">{commanderDisplayName(cmd)}</span>
                    <span class="planner-v__cmd-nation">{cmd.nations.join(" / ").replace(/_/g, " ")}</span>
                  </button>
                );
              })}
            </div>
          )}
          {list.length > 0 ? <p class="planner-v__note">{t("ships.skills.commanderLegend")}</p> : null}
          {selected ? (
            <div class="planner-v__talents">
              {selected.talents.map((talent, ti) => (
                <div class="planner-v__talent" key={talent.activatorType + ti}>
                  <div class="planner-v__talent-head">
                    <span class="planner-v__talent-trigger">
                      {t("ships.skills.talentTrigger")} · {activatorLabel(talent.activatorType)}
                    </span>
                    {talent.maxTriggerNum > 0 ? (
                      <span class="planner-v__talent-max">
                        {t("ships.skills.talentMax", { n: talent.maxTriggerNum })}
                      </span>
                    ) : null}
                  </div>
                  {talentRows(talent).map((row) => (
                    <div class="planner-v__talent-row" key={row.level}>
                      <span class="planner-v__talent-level">{row.level}</span>
                      {row.kv.map(([k, v]) => (
                        <span class="planner-v__talent-kv" key={k}>
                          {talentEffectLabel(k)} {fmtTalentValue(k, v)}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    function renderFlags() {
      const tip = flagTip.value;
      return (
        <div class="planner-v__flags">
          {SIGNALS.map((sig) => {
            const active = props.build.signals.includes(sig.index);
            const name = signalName(sig);
            return (
              <button
                type="button"
                class={["planner-v__flag", active ? "planner-v__flag--active" : ""]}
                key={sig.index}
                onClick={() => toggleSignal(sig.index)}
                onMouseenter={(e) => showFlagTip(sig, e.currentTarget as HTMLElement)}
                onMouseleave={hideFlagTip}
                onFocus={(e) => showFlagTip(sig, e.currentTarget as HTMLElement)}
                onBlur={hideFlagTip}
              >
                <span class="planner-v__flag-icon">
                  <AssetImage
                    class="planner-v__flag-img"
                    src={signalIconUrl(sig.name)}
                    alt={name}
                    fallback={<span>{name.charAt(0)}</span>}
                  />
                </span>
                <span class="planner-v__flag-name">{name}</span>
              </button>
            );
          })}
          {tip ? (
            /* Teleported to <body>: the ship-detail modal content carries a
               transform, which would re-anchor a plain fixed card and its
               overflow:hidden would clip it away entirely. */
            <Teleport to="body">
              <div class="flag-card" ref={flagTipEl} style={flagTipPos.value}>
                <div class="flag-card__name">{signalName(tip.sig)}</div>
                <div class="flag-card__flavor">{dataText(tip.sig.desc, "")}</div>
                <div class="flag-card__effects">
                  {flagEffects(tip.sig).map((e) => (
                    <div class="flag-card__effect" key={e.key}>
                      <span class="flag-card__effect-label">{e.label}</span>
                      <span
                        class={[
                          "flag-card__effect-value",
                          e.good ? "flag-card__effect-value--good" : "flag-card__effect-value--bad",
                        ]}
                      >
                        {e.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Teleport>
          ) : null}
        </div>
      );
    }

    function renderUpgrades() {
      return (
        <div class="planner-v__slots">
          {shipSlots.value.map((slot) => {
            const mods = upgradesForSlot(slot);
            return (
              <div class="planner-v__slot" key={slot}>
                <div class="planner-v__slot-title">
                  {t("ships.skills.slot", { n: slot + 1 })}
                  {props.build.upgrades[slot] ? (
                    <button
                      type="button"
                      class="planner-v__slot-clear"
                      onClick={() => toggleUpgrade(slot, props.build.upgrades[slot])}
                    >
                      {t("ships.skills.slotNone")}
                    </button>
                  ) : null}
                </div>
                <div class="planner-v__slot-grid">
                  {mods.length === 0 ? (
                    <p class="planner-v__slot-empty">{t("ships.skills.slotEmpty")}</p>
                  ) : (
                    mods.map((mod) => {
                      const active = props.build.upgrades[slot] === mod.name;
                      const unique = mod.tags?.includes("unique") ?? false;
                      const name = dataText(mod.names, mod.name);
                      const desc = dataText(mod.desc, "");
                      return (
                        <button
                          type="button"
                          class={[
                            "planner-v__mod",
                            active ? "planner-v__mod--active" : "",
                            unique ? "planner-v__mod--unique" : "",
                          ]}
                          key={mod.name}
                          onClick={() => toggleUpgrade(slot, mod.name)}
                          data-hint={desc || name}
                        >
                          <span class="planner-v__mod-icon">
                            <AssetImage
                              class="planner-v__mod-img"
                              src={modernizationIconUrl(mod.name)}
                              alt={name}
                              fallback={<span>{name.charAt(0)}</span>}
                            />
                          </span>
                          <span class="planner-v__mod-name">{name}</span>
                          {unique ? (
                            <span class="planner-v__mod-unique">{t("ships.skills.uniqueMod")}</span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    /** The selected build's shopping list with per-item credit prices. */
    const costRows = computed(() =>
      Object.entries(props.build.upgrades).map(([slot, name]) => {
        const mod = MODERNIZATIONS.find((m) => m.name === name);
        return {
          slot,
          name,
          label: (mod?.names && dataText(mod.names, name)) || name,
          price: priceOf(prices.value, name),
        };
      }),
    );
    const upgradesCredits = computed(() =>
      costRows.value.reduce((sum, r) => sum + (r.price ?? 0), 0),
    );
    const totalCredits = computed(
      () => upgradesCredits.value + retrainCredits(usedPoints.value),
    );

    function renderCosts() {
      const fmt = (n: number) => n.toLocaleString();
      const cr = t("ships.skills.costCredits");
      return (
        <div class="planner-v__costs">
          <div class="planner-v__cost-total">
            <span class="planner-v__cost-total-label">{t("ships.skills.costTotal")}</span>
            <span class="planner-v__cost-total-value">
              {fmt(totalCredits.value)} <em>{cr}</em>
            </span>
          </div>

          <h4 class="planner-v__cost-head">{t("ships.skills.costUpgrades")}</h4>
          {costRows.value.length === 0 ? (
            <p class="planner-v__cost-empty">{t("ships.skills.costNone")}</p>
          ) : (
            <div class="planner-v__cost-rows">
              {costRows.value.map((r) => (
                <div class="planner-v__cost-row" key={`${r.slot}_${r.name}`}>
                  <span class="planner-v__cost-slot">
                    {t("ships.skills.slot", { n: Number(r.slot) + 1 })}
                  </span>
                  <span class="planner-v__cost-name">{r.label}</span>
                  <span class="planner-v__cost-price">
                    {r.price != null ? (
                      <>
                        {fmt(r.price)} <em>{cr}</em>
                      </>
                    ) : (
                      <em>{t("ships.skills.costNoPrice")}</em>
                    )}
                  </span>
                </div>
              ))}
              <div class="planner-v__cost-row planner-v__cost-row--sum">
                <span />
                <span class="planner-v__cost-name">{t("ships.skills.costUpgradesSum")}</span>
                <span class="planner-v__cost-price">
                  {fmt(upgradesCredits.value)} <em>{cr}</em>
                </span>
              </div>
            </div>
          )}

          <h4 class="planner-v__cost-head">{t("ships.skills.costCaptain")}</h4>
          <div class="planner-v__cost-rows">
            <div class="planner-v__cost-row">
              <span class="planner-v__cost-slot">{t("ships.skills.costSkillPoints")}</span>
              <span class="planner-v__cost-name">
                {usedPoints.value} {t("ships.skills.costPoints")}
              </span>
              <span class="planner-v__cost-price">
                {fmt(cxpForPoints(usedPoints.value))} {t("ships.skills.costCxP")}
              </span>
            </div>
            <div class="planner-v__cost-row" data-hint={t("ships.skills.costRetrainHint")}>
              <span class="planner-v__cost-slot">{t("ships.skills.costRetrain")}</span>
              <span class="planner-v__cost-name">{usedPoints.value} × 100,000</span>
              <span class="planner-v__cost-price">
                {fmt(retrainCredits(usedPoints.value))} <em>{cr}</em>
              </span>
            </div>
          </div>

          <h4 class="planner-v__cost-head">{t("ships.skills.costFlags")}</h4>
          <div class="planner-v__cost-rows">
            <div class="planner-v__cost-row">
              <span class="planner-v__cost-slot">{props.build.signals.length}</span>
              <span class="planner-v__cost-name">{t("ships.skills.costFlagsNote")}</span>
              <span class="planner-v__cost-price">—</span>
            </div>
          </div>

          {pricesError.value ? (
            <p class="planner-v__cost-note">{t("ships.skills.costNoPrices")}</p>
          ) : null}
        </div>
      );
    }

    function renderSection() {
      switch (section.value) {
        case "captains":
          return renderCommanders();
        case "flags":
          return renderFlags();
        case "upgrades":
          return renderUpgrades();
        case "costs":
          return renderCosts();
        default:
          return renderSkills();
      }
    }

    return () => {
      const b = props.build;
      const hpPct = Math.round(b.healthPct * 100);
      return (
        <div class="planner-v">
          {/* ── Top bar: point counter + reset ── */}
          <div class="planner-v__bar">
            <span
              class={["planner-v__points", remaining.value < 0 ? "planner-v__points--over" : ""]}
            >
              {t("ships.skills.pointsUsed", { used: usedPoints.value, max: SKILL_BUDGET })}
            </span>
            <span class="planner-v__remaining">
              {remaining.value >= 0
                ? t("ships.skills.remaining", { n: remaining.value })
                : t("ships.skills.overBudget")}
            </span>
            <HButton
              variant="ghost"
              size="sm"
              onClick={() =>
                setBuild({ skills: {}, signals: [], upgrades: {}, commander: null })
              }
            >
              <RotateCcw size={12} /> {t("ships.skills.reset")}
            </HButton>
          </div>

          <div class="planner-v__body">
            {/* ── Left rail: section switcher ── */}
            <nav class="planner-v__rail">
              {RAIL.map((item) => (
                <button
                  type="button"
                  class={["planner-v__rail-btn", section.value === item.key ? "planner-v__rail-btn--active" : ""]}
                  key={item.key}
                  onClick={() => (section.value = item.key)}
                >
                  {item.icon ? (
                    <AssetImage
                      class="planner-v__rail-icon"
                      src={item.icon}
                      alt={t(`ships.skills.${item.labelKey}`)}
                      fallback={<span>{t(`ships.skills.${item.labelKey}`).charAt(0)}</span>}
                    />
                  ) : (
                    <span class="planner-v__rail-icon planner-v__rail-icon--glyph">
                      <Coins size={18} />
                    </span>
                  )}
                  <span class="planner-v__rail-label">{t(`ships.skills.${item.labelKey}`)}</span>
                </button>
              ))}
            </nav>

            {/* ── Center: active section ── */}
            <div class="planner-v__center">{renderSection()}</div>

            {/* ── Right: combined stats + HP slider ── */}
            <aside class="planner-v__stats">
              <h4 class="planner-v__stats-title">{t("ships.skills.statsTitle")}</h4>
              <div class="planner-v__hp">
                <label class="planner-v__hp-label">
                  {t("ships.skills.health")}:
                  <strong>{hpPct}%</strong>
                </label>
                <input
                  class="planner-v__hp-input"
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={hpPct}
                  onInput={(e) => setBuild({ healthPct: Number((e.target as HTMLInputElement).value) / 100 })}
                />
              </div>
              <DataObserver ship={props.ship} build={b} />
            </aside>
          </div>
        </div>
      );
    };
  },
});
