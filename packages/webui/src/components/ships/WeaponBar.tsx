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

/** Extract weapon cards from GameParams.  Each HP_* slot becomes its own card
 *  so multiple distinct mount groups (e.g. two secondary calibres) are listed
 *  separately.  AA auras are also shown per-range-tier when distinguishable. */
function buildWeapons(gp: Gp): WeaponCard[] {
  if (!gp || typeof gp !== "object") return [];

  const out: WeaponCard[] = [];

  // ── Main battery ── A_Artillery.HP_*
  const art = gp.A_Artillery ?? gp.Hull?.artillery;
  if (art && typeof art === "object") {
    const mounts = Object.entries(art).filter(([k]) => k.startsWith("HP_"));
    for (const [, m] of mounts) {
      if (!m || typeof m !== "object") continue;
      const barrels = Number(m.numBarrels ?? 0) || 1;
      const cal = (Number(m.barrelDiameter ?? 0) * 1000).toFixed(0);
      out.push({
        key: `mainGun_${out.length}`,
        icon: Crosshair,
        label: t("ships.detail.weapon.mainGun"),
        detail: `${barrels}× ${cal}mm`,
        zone: "bow",
        count: 1,
      });
    }
  }

  // ── Secondary battery ── A_ATBA.HP_*
  const atba = gp.A_ATBA;
  if (atba && typeof atba === "object") {
    const mounts = Object.entries(atba).filter(([k]) => k.startsWith("HP_"));
    for (const [, m] of mounts) {
      if (!m || typeof m !== "object") continue;
      const barrels = Number(m.numBarrels ?? 0) || 1;
      const cal = (Number(m.barrelDiameter ?? 0) * 1000).toFixed(0);
      out.push({
        key: `secondary_${out.length}`,
        icon: Rocket,
        label: t("ships.detail.weapon.secondary"),
        detail: cal ? `${barrels}× ${cal}mm` : `${barrels}×`,
        zone: "midship",
        count: 1,
      });
    }
  }

  // ── Torpedoes ── A_AirArmament.HP_* (tube launchers)
  const torp = gp.A_AirArmament ?? gp.Hull?.torpedoes;
  if (torp && typeof torp === "object") {
    const tubes = Object.entries(torp).filter(([k]) => k.startsWith("HP_"));
    for (const [, t] of tubes) {
      if (!t || typeof t !== "object") continue;
      const countVal = Number(t.numBarrels ?? t.count ?? 1) || 1;
      out.push({
        key: `torpedo_${out.length}`,
        icon: Target,
        label: t("ships.detail.weapon.torpedo"),
        detail: `${countVal}×`,
        zone: "midship",
        count: 1,
      });
    }
  }

  // ── Anti-air (auras) ── A_AirDefense
  const aa = gp.A_AirDefense;
  if (aa && typeof aa === "object") {
    const auras = Object.entries(aa).filter(
      ([k, v]) => (k.startsWith("HP_") || /^\d+$/.test(k)) && v && typeof v === "object",
    );
    // Try to extract range tiers so the user can tell long/medium/short apart.
    for (const [, a] of auras) {
      const maxDist = Number(a.maxDistance ?? 0);
      const label = maxDist > 5
        ? t("ships.detail.weapon.aaLong")
        : maxDist > 2.5
          ? t("ships.detail.weapon.aaMid")
          : t("ships.detail.weapon.aaShort");
      out.push({
        key: `aa_${out.length}`,
        icon: Wind,
        label: `${t("ships.detail.weapon.aaGun")} ${label}`,
        detail: maxDist > 0 ? `${maxDist.toFixed(1)}km` : "—",
        zone: "deck",
        count: 1,
      });
    }
  }

  // ── ASW / depth charges ── A_DepthCharge
  const dc = gp.A_DepthCharge;
  if (dc && typeof dc === "object") {
    const mounts = Object.entries(dc).filter(([k]) => k.startsWith("HP_"));
    if (mounts.length > 0) {
      out.push({
        key: "asw",
        icon: Anchor,
        label: t("ships.detail.weapon.asw"),
        detail: `${mounts.length} ${t("ships.detail.weapon.launchers")}`,
        zone: "stern",
        count: mounts.length,
      });
    }
  }

  // ── Aircraft ── A_Airplane
  const plane = gp.A_Airplane;
  if (plane && typeof plane === "object") {
    const sq = Object.entries(plane).filter(([k]) => k.startsWith("HP_"));
    if (sq.length > 0) {
      out.push({
        key: "aircraft",
        icon: PlaneIcon,
        label: t("ships.detail.weapon.aircraft"),
        detail: `${sq.length} ${t("ships.detail.weapon.squadrons")}`,
        zone: "stern",
        count: sq.length,
      });
    }
  }

  // ── Engine ──
  const eng = gp.A_Engine;
  if (eng && typeof eng === "object") {
    out.push({
      key: "engine",
      icon: Gauge,
      label: t("ships.detail.weapon.engine"),
      detail: eng.engineType ? String(eng.engineType) : "—",
      zone: "stern",
      count: 1,
    });
  }

  // ── Finders (rangefinders / optics) ──
  const finders = gp.A_Finders;
  if (finders && typeof finders === "object") {
    const fs = Object.keys(finders).filter((k) => k.startsWith("HP_"));
    if (fs.length > 0) {
      out.push({
        key: "finder",
        icon: Radar,
        label: t("ships.detail.weapon.finder"),
        detail: `${fs.length}`,
        zone: "deck",
        count: fs.length,
      });
    }
  }

  return out;
}

function PlaneIcon() {
  // Inline SVG for aircraft — lucide doesn't have a perfect match.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.7-.1-1.3.5-1.2 1.2l1.5 6.5c.1.4.5.7.9.7h.1l5.5-.7 3 3c.3.3.7.5 1.1.5h.1c.7-.1 1.1-.8.9-1.5z" />
    </svg>
  );
}

export default defineComponent({
  name: "WeaponBar",
  props: {
    gameparams: { type: Object as PropType<Gp>, default: null },
  },
  emits: {
    focus: (_zone: FocusZone, _count?: number) => true,
  },
  setup(props, { emit }) {
    const weapons = computed(() => buildWeapons(props.gameparams));
    return () => {
      if (weapons.value.length === 0) return null;
      return (
        <div class="weapon-bar">
          {weapons.value.map((w) => (
            <button
              key={w.key}
              class="weapon-bar__btn"
              title={w.label}
              onClick={() => emit("focus", w.zone, w.count)}
            >
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
