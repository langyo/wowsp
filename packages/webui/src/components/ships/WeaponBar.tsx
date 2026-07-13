import { defineComponent, computed, type PropType } from "vue";
import { Crosshair, Target, Wind, Gauge, Radar, Rocket } from "lucide-vue-next";

import { t } from "@/i18n";
import type { FocusZone } from "./ShipStage";
import "./WeaponBar.scss";

/**
 * Weapon module bar — a row of clickable weapon cards under the ship stage.
 *
 * Each card summarises one weapon system parsed from GameParams (main battery
 * / torpedoes / anti-air / engine / finders) and, on click, asks the parent to
 * fly the 3D stage camera to that module's region. The actual zone mapping is
 * approximate (GameParams `position` is a logical index, not world coords), so
 * we map each weapon type to a bbox-relative camera preset in ShipStage.
 */

type Gp = Record<string, any> | null | undefined;

interface WeaponCard {
  key: string;
  icon: typeof Crosshair;
  label: string;
  detail: string;
  zone: FocusZone;
}

/** Extract a short weapon summary list from a GameParams subtree. */
function buildWeapons(gp: Gp): WeaponCard[] {
  if (!gp || typeof gp !== "object") return [];
  const out: WeaponCard[] = [];

  // Main battery — A_Artillery.HP_JGM_* (count turrets + barrels + caliber).
  const art = gp.A_Artillery ?? gp.Hull?.artillery;
  if (art && typeof art === "object") {
    const mounts = Object.entries(art).filter(
      ([k]) => k.startsWith("HP_") || k.startsWith("_"),
    );
    if (mounts.length > 0) {
      let barrels = 0;
      let caliber = 0;
      let turretCount = mounts.length;
      for (const [, m] of mounts) {
        if (m && typeof m === "object") {
          barrels += Number(m.numBarrels ?? 0) || 0;
          const dia = Number(m.barrelDiameter ?? 0);
          if (dia > caliber) caliber = dia;
        }
      }
      out.push({
        key: "mainGun",
        icon: Crosshair,
        label: t("ships.detail.weapon.mainGun"),
        detail: `${turretCount}×${Math.max(1, Math.round(barrels / turretCount))} ${(caliber * 1000).toFixed(0)}mm`,
        zone: "bow",
      });
    }
  }

  // Torpedoes — A_AirArmament.HP_JC_* (tube launchers).
  const torp = gp.A_AirArmament ?? gp.Hull?.torpedoes;
  if (torp && typeof torp === "object") {
    const tubes = Object.entries(torp).filter(([k]) => k.startsWith("HP_"));
    if (tubes.length > 0) {
      out.push({
        key: "torpedo",
        icon: Target,
        label: t("ships.detail.weapon.torpedo"),
        detail: `${tubes.length} ${t("ships.detail.weapon.launchers")}`,
        zone: "midship",
      });
    }
  }

  // Anti-air — A_AirDefense (has aura / gun slots).
  const aa = gp.A_AirDefense;
  if (aa && typeof aa === "object") {
    const slots = Object.keys(aa).filter(
      (k) => k.startsWith("HP_") || /^\d+$/.test(k),
    );
    out.push({
      key: "aaGun",
      icon: Wind,
      label: t("ships.detail.weapon.aaGun"),
      detail: slots.length > 0 ? `${slots.length} ${t("ships.detail.weapon.auras")}` : "—",
      zone: "deck",
    });
  }

  // Secondary battery — A_ATBA.
  const atba = gp.A_ATBA;
  if (atba && typeof atba === "object") {
    const secs = Object.keys(atba).filter((k) => k.startsWith("HP_"));
    if (secs.length > 0) {
      out.push({
        key: "secondary",
        icon: Rocket,
        label: t("ships.detail.weapon.secondary"),
        detail: `${secs.length}`,
        zone: "midship",
      });
    }
  }

  // Engine — A_Engine.
  const eng = gp.A_Engine;
  if (eng && typeof eng === "object") {
    out.push({
      key: "engine",
      icon: Gauge,
      label: t("ships.detail.weapon.engine"),
      detail: eng.engineType ? String(eng.engineType) : "—",
      zone: "stern",
    });
  }

  // Finders (rangefinders / optics) — A_Finders.
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
      });
    }
  }

  return out;
}

export default defineComponent({
  name: "WeaponBar",
  props: {
    /** GameParams subtree for the ship (loaded lazily by the modal). */
    gameparams: { type: Object as PropType<Gp>, default: null },
  },
  emits: {
    focus: (_zone: FocusZone) => true,
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
              onClick={() => emit("focus", w.zone)}
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
