import { defineComponent, computed, type PropType } from "vue";
import { Crosshair, Target, Wind, Rocket, Anchor } from "@lucide/vue";

import { t } from "@/i18n";
import { resolveShipParts, type ShipParts } from "./shipParts";
import { summarizeWeapons, type WeaponGroup } from "./shipWeapons";
import { auraBandMap, type AaBandKey } from "./antiAir";
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

function cardsOf(groups: WeaponGroup[]): WeaponCard[] {
  const out: WeaponCard[] = [];
  for (const g of groups) {
    switch (g.kind) {
      case "mainGun":
        out.push({
          key: `mainGun_${g.cal}_${g.barrels}`,
          icon: Crosshair,
          label: t("ships.detail.weapon.mainGun"),
          detail: `${g.count}×${g.barrels} ${g.cal}mm`,
          zone: "bow",
          count: g.count,
        });
        break;
      case "secondary":
        out.push({
          key: `secondary_${g.cal}`,
          icon: Rocket,
          label: t("ships.detail.weapon.secondary"),
          detail: `${g.count}×${g.barrels} ${g.cal}mm`,
          zone: "midship",
          count: g.count,
        });
        break;
      case "dp":
        out.push({
          key: `dp_${g.cal}`,
          icon: Crosshair,
          label: t("ships.detail.weapon.dp"),
          detail: `${g.count}×${g.barrels} ${g.cal}mm`,
          zone: "midship",
          count: g.count,
        });
        break;
      case "torpedo":
        out.push({
          key: `torpedo_${g.barrels}`,
          icon: Target,
          label: t("ships.detail.weapon.torpedo"),
          detail: `${g.count}×${g.barrels}`,
          zone: "midship",
          count: g.count,
        });
        break;
      case "aa":
        out.push({
          key: `aa_${g.band}`,
          icon: Wind,
          label: `${t("ships.detail.weapon.aaGun")} ${t(
            `ships.detail.weapon.${g.band === "long" ? "aaLong" : g.band === "mid" ? "aaMid" : "aaShort"}`,
          )}`,
          detail: `${g.count} ${t("ships.detail.weapon.auras")}`,
          zone: "deck",
          count: g.count,
        });
        break;
      case "asw":
        out.push({
          key: "asw",
          icon: Anchor,
          label: t("ships.detail.weapon.asw"),
          detail: `${g.count} ${t("ships.detail.weapon.launchers")}`,
          zone: "stern",
          count: g.count,
        });
        break;
      case "aircraft":
        out.push({
          key: "aircraft",
          icon: PlaneIcon,
          label: t("ships.detail.weapon.aircraft"),
          detail: `${g.count} ${t("ships.detail.weapon.launchers")}`,
          zone: "stern",
          count: g.count,
        });
        break;
    }
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
    const weapons = computed(() => {
      const gp = props.gameparams;
      if (!gp || typeof gp !== "object") return [] as WeaponCard[];
      // Weapon groups read the TOP configuration (fully upgraded — the same
      // convention as the spec panel's numbers); AA mount bands come from
      // the same resolved blocks so slot keys line up.
      const parts: ShipParts = resolveShipParts(gp, "top");
      const bandOf: Map<string, AaBandKey> = auraBandMap([
        ...parts.airDefense,
        ...parts.atba,
        ...parts.artillery,
      ]);
      return cardsOf(summarizeWeapons(gp, { parts, bandOf }));
    });
    return () => {
      if (weapons.value.length === 0) return null;
      return (
        <div class="weapon-bar">
          {weapons.value.map((w) => (
            <button key={w.key} class="weapon-bar__btn" data-hint={w.label}
              onClick={() => emit("focus", w.zone, w.count)}>
              <w.icon size={14} />
              <span class="weapon-bar__label">{w.label}</span>
              <span class="weapon-bar__detail">
                {w.detail}
                <strong class="weapon-bar__count">×{w.count}</strong>
              </span>
            </button>
          ))}
        </div>
      );
    };
  },
});
