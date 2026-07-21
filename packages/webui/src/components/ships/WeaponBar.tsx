import { defineComponent, computed, type PropType } from "vue";
import { Crosshair, Target, Wind, Gauge, Radar, Rocket, Anchor } from "lucide-vue-next";

import { t } from "@/i18n";
import type { FocusZone } from "./ShipStage";
import "./WeaponBar.scss";

type Gp = Record<string, any> | null | undefined;

interface WeaponCard {
  key: string;
  icon: typeof Crosshair;
  label: string;
  detail: string;
  zone: FocusZone;
  count: number;
}

/** Aggregate same-spec mounts into grouped cards.  Identical mounts are merged
 *  (e.g. four 2×460mm turrets → one "4×2 460mm" card), AA auras collapse by
 *  range tier, and distinct calibres stay separate. */
function buildWeapons(gp: Gp): WeaponCard[] {
  if (!gp || typeof gp !== "object") return [];

  const out: WeaponCard[] = [];

  // ── Main battery ── A_Artillery.HP_*
  const art = gp.A_Artillery ?? gp.Hull?.artillery;
  if (art && typeof art === "object") {
    const groups = new Map<string, { barrels: number; cal: number; count: number }>();
    for (const [k, m] of Object.entries(art)) {
      if (!k.startsWith("HP_") || !m || typeof m !== "object") continue;
      const barrels = Number(m.numBarrels ?? 0) || 1;
      const cal = Math.round((Number(m.barrelDiameter ?? 0)) * 1000);
      const key = `${barrels}_${cal}`;
      const g = groups.get(key);
      if (g) { g.count++; } else { groups.set(key, { barrels, cal, count: 1 }); }
    }
    for (const [, g] of groups) {
      out.push({
        key: `mainGun_${g.cal}`,
        icon: Crosshair,
        label: t("ships.detail.weapon.mainGun"),
        detail: `${g.count}×${g.barrels} ${g.cal}mm`,
        zone: "bow",
        count: g.count,
      });
    }
  }

  // ── Secondary battery ── A_ATBA.HP_*
  const atba = gp.A_ATBA;
  if (atba && typeof atba === "object") {
    const groups = new Map<string, { barrels: number; cal: number; count: number }>();
    for (const [k, m] of Object.entries(atba)) {
      if (!k.startsWith("HP_") || !m || typeof m !== "object") continue;
      const barrels = Number(m.numBarrels ?? 0) || 1;
      const cal = Math.round((Number(m.barrelDiameter ?? 0)) * 1000);
      const key = `${barrels}_${cal}`;
      const g = groups.get(key);
      if (g) { g.count++; } else { groups.set(key, { barrels, cal, count: 1 }); }
    }
    for (const [, g] of groups) {
      out.push({
        key: `secondary_${g.cal}`,
        icon: Rocket,
        label: t("ships.detail.weapon.secondary"),
        detail: `${g.count}×${g.barrels} ${g.cal}mm`,
        zone: "midship",
        count: g.count,
      });
    }
  }

  // ── Torpedoes ── A_AirArmament.HP_* (tube launchers)
  const torp = gp.A_AirArmament ?? gp.Hull?.torpedoes;
  if (torp && typeof torp === "object") {
    let tubeCount = 0;
    let tubeBarr = 0;
    for (const [k, t] of Object.entries(torp)) {
      if (!k.startsWith("HP_") || !t || typeof t !== "object") continue;
      tubeCount++;
      tubeBarr = Math.max(tubeBarr, Number(t.numBarrels ?? t.count ?? 1) || 1);
    }
    if (tubeCount > 0) {
      out.push({
        key: "torpedo",
        icon: Target,
        label: t("ships.detail.weapon.torpedo"),
        detail: `${tubeCount}×${tubeBarr}`,
        zone: "midship",
        count: tubeCount,
      });
    }
  }

  // ── Anti-air (auras) — collapse by range tier ──
  const aa = gp.A_AirDefense;
  if (aa && typeof aa === "object") {
    const tiers: Record<string, number> = { long: 0, mid: 0, short: 0 };
    for (const [k, a] of Object.entries(aa)) {
      if (!(k.startsWith("HP_") || /^\d+$/.test(k))) continue;
      if (!a || typeof a !== "object") continue;
      const dist = Number(a.maxDistance ?? 0);
      if (dist > 5) tiers.long++;
      else if (dist > 2.5) tiers.mid++;
      else tiers.short++;
    }
    if (tiers.long > 0) {
      out.push({
        key: "aa_long",
        icon: Wind,
        label: `${t("ships.detail.weapon.aaGun")} ${t("ships.detail.weapon.aaLong")}`,
        detail: `${tiers.long} ${t("ships.detail.weapon.auras")}`,
        zone: "deck",
        count: tiers.long,
      });
    }
    if (tiers.mid > 0) {
      out.push({
        key: "aa_mid",
        icon: Wind,
        label: `${t("ships.detail.weapon.aaGun")} ${t("ships.detail.weapon.aaMid")}`,
        detail: `${tiers.mid} ${t("ships.detail.weapon.auras")}`,
        zone: "deck",
        count: tiers.mid,
      });
    }
    if (tiers.short > 0) {
      out.push({
        key: "aa_short",
        icon: Wind,
        label: `${t("ships.detail.weapon.aaGun")} ${t("ships.detail.weapon.aaShort")}`,
        detail: `${tiers.short} ${t("ships.detail.weapon.auras")}`,
        zone: "deck",
        count: tiers.short,
      });
    }
  }

  // ── ASW ──
  const dc = gp.A_DepthCharge;
  if (dc && typeof dc === "object") {
    const n = Object.keys(dc).filter((k) => k.startsWith("HP_")).length;
    if (n > 0) out.push({
      key: "asw", icon: Anchor, label: t("ships.detail.weapon.asw"),
      detail: `${n} ${t("ships.detail.weapon.launchers")}`, zone: "stern", count: n,
    });
  }

  // ── Aircraft ──
  const ac = gp.A_Airplane;
  if (ac && typeof ac === "object") {
    const n = Object.keys(ac).filter((k) => k.startsWith("HP_")).length;
    if (n > 0) out.push({
      key: "aircraft", icon: PlaneIcon, label: t("ships.detail.weapon.aircraft"),
      detail: `${n} ${t("ships.detail.weapon.squadrons")}`, zone: "stern", count: n,
    });
  }

  // ── Engine ──
  const eng = gp.A_Engine;
  if (eng && typeof eng === "object") {
    out.push({
      key: "engine", icon: Gauge, label: t("ships.detail.weapon.engine"),
      detail: eng.engineType ? String(eng.engineType) : "—", zone: "stern", count: 1,
    });
  }

  // ── Finders ──
  const finders = gp.A_Finders;
  if (finders && typeof finders === "object") {
    const n = Object.keys(finders).filter((k) => k.startsWith("HP_")).length;
    if (n > 0) out.push({
      key: "finder", icon: Radar, label: t("ships.detail.weapon.finder"),
      detail: `${n}`, zone: "deck", count: n,
    });
  }

  return out;
}

function PlaneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.7-.1-1.3.5-1.2 1.2l1.5 6.5c.1.4.5.7.9.7h.1l5.5-.7 3 3c.3.3.7.5 1.1.5h.1c.7-.1 1.1-.8.9-1.5z" />
    </svg>
  );
}

export default defineComponent({
  name: "WeaponBar",
  props: { gameparams: { type: Object as PropType<Gp>, default: null } },
  emits: { focus: (_zone: FocusZone, _count?: number) => true },
  setup(props, { emit }) {
    const weapons = computed(() => buildWeapons(props.gameparams));
    return () => {
      if (weapons.value.length === 0) return null;
      return (
        <div class="weapon-bar">
          {weapons.value.map((w) => (
            <button key={w.key} class="weapon-bar__btn" title={w.label}
              onClick={() => emit("focus", w.zone, w.count)}>
              <w.icon size={14} />
              <span class="weapon-bar__label">{w.label}</span>
              <span class="weapon-bar__detail">{w.detail}</span>
            </button>
          ))}
        </div>
      );
    };
  },
});
