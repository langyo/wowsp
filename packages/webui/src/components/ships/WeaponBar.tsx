import { defineComponent, computed, type PropType } from "vue";
import { Crosshair, Target, Wind, Gauge, Rocket, Anchor } from "lucide-vue-next";

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

function hpSlots(obj: Record<string, any>): [string, Record<string, any>][] {
  return Object.entries(obj).filter(
    ([k, v]) => k.startsWith("HP_") && v && typeof v === "object",
  ) as [string, Record<string, any>][];
}

/** Collect the set of gun model names/ids from an A_* block. */
function gunIds(block: Record<string, any> | undefined): Set<string> {
  const ids = new Set<string>();
  if (!block || typeof block !== "object") return ids;
  for (const [, m] of hpSlots(block)) {
    const n = m.name ?? m.id ?? "";
    if (n) ids.add(String(n));
  }
  return ids;
}

function buildWeapons(gp: Gp): WeaponCard[] {
  if (!gp || typeof gp !== "object") return [];
  const out: WeaponCard[] = [];

  const atbaIds = gunIds(gp.A_ATBA);
  const aaIds = gunIds(gp.A_AirDefense);

  // ── Main battery ── A_Artillery.HP_* (fall back to A_ATBA for DDs)
  const art = gp.A_Artillery ?? gp.Hull?.artillery;
  const mainSource = (art && typeof art === "object" && hpSlots(art).length > 0) ? art : gp.A_ATBA;
  // Track which ATBA slots are "promoted" to main battery so they aren't
  // listed again under secondaries.
  const promotedAtba = new Set<string>();
  if (mainSource && typeof mainSource === "object") {
    const groups = new Map<string, { barrels: number; cal: number; count: number; slots: string[] }>();
    for (const [k, m] of hpSlots(mainSource)) {
      const barrels = Number(m.numBarrels ?? 0) || 1;
      const cal = Math.round((Number(m.barrelDiameter ?? 0)) * 1000);
      const key = `${barrels}_${cal}`;
      const g = groups.get(key);
      if (g) { g.count++; g.slots.push(k); } else { groups.set(key, { barrels, cal, count: 1, slots: [k] }); }
    }
    // If mainSource is A_ATBA (not true A_Artillery), only promote the
    // LARGEST caliber group to main battery — keep rest as secondaries.
    const entries = [...groups.values()].sort((a, b) => b.cal - a.cal);
    const promoteAll = mainSource === art; // true A_Artillery → all groups are main battery
    for (const g of entries) {
      if (!promoteAll && g !== entries[0]) break; // only top group from ATBA
      for (const s of g.slots) promotedAtba.add(s);
      out.push({
        key: `mainGun_${g.cal}_${g.barrels}`,
        icon: Crosshair,
        label: t("ships.detail.weapon.mainGun"),
        detail: `${g.count}×${g.barrels} ${g.cal}mm`,
        zone: "bow",
        count: g.count,
      });
    }
  }

  // ── Dual-purpose (high-angle) guns ──
  // Detect guns that appear in both A_ATBA (secondary) AND A_AirDefense (AA).
  // These are DP mounts — show once with a combined label.
  const atbaSlots = hpSlots(gp.A_ATBA ?? {});
  const aaSlots = hpSlots(gp.A_AirDefense ?? {});
  const dpSlots = new Set<string>();
  for (const [k, m] of atbaSlots) {
    const id = String(m.name ?? m.id ?? "");
    if (id && aaIds.has(id)) dpSlots.add(k);
  }
  for (const [k, m] of aaSlots) {
    const id = String(m.name ?? m.id ?? "");
    if (id && atbaIds.has(id)) dpSlots.add(k);
  }

  // ── Secondary battery (excluding DP guns + slots promoted to main) ──
  if (gp.A_ATBA && typeof gp.A_ATBA === "object") {
    const groups = new Map<string, { barrels: number; cal: number; count: number }>();
    for (const [k, m] of atbaSlots) {
      if (dpSlots.has(k) || promotedAtba.has(k)) continue;
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

  // ── Dual-purpose guns (combined DP + AA slots) ──
  if (dpSlots.size > 0) {
    const groups = new Map<string, { barrels: number; cal: number; count: number }>();
    for (const [k, m] of [...atbaSlots, ...aaSlots]) {
      if (!dpSlots.has(k)) continue;
      const barrels = Number(m.numBarrels ?? 0) || 1;
      const cal = Math.round((Number(m.barrelDiameter ?? 0)) * 1000);
      const key = `${barrels}_${cal}`;
      const g = groups.get(key);
      if (g) { g.count++; } else { groups.set(key, { barrels, cal, count: 1 }); }
    }
    for (const [, g] of groups) {
      out.push({
        key: `dp_${g.cal}`,
        icon: Crosshair,
        label: t("ships.detail.weapon.dp"),
        detail: `${g.count}×${g.barrels} ${g.cal}mm`,
        zone: "midship",
        count: g.count,
      });
    }
  }

  // ── Torpedoes — group by tube count ──
  const torp = gp.A_AirArmament ?? gp.Hull?.torpedoes;
  if (torp && typeof torp === "object") {
    const groups = new Map<number, number>();
    for (const [, t] of hpSlots(torp)) {
      const n = Number(t.numBarrels ?? t.count ?? 1) || 1;
      groups.set(n, (groups.get(n) ?? 0) + 1);
    }
    for (const [tubes, count] of groups) {
      out.push({
        key: `torpedo_${tubes}`,
        icon: Target,
        label: t("ships.detail.weapon.torpedo"),
        detail: `${count}×${tubes}`,
        zone: "midship",
        count,
      });
    }
  }

  // ── AA (non-DP only) — collapse by range tier ──
  const aa = gp.A_AirDefense;
  if (aa && typeof aa === "object") {
    const tiers: Record<string, number> = { long: 0, mid: 0, short: 0 };
    for (const [k, a] of aaSlots) {
      if (dpSlots.has(k)) continue;
      const dist = Number(a.maxDistance ?? 0);
      if (dist > 5) tiers.long++;
      else if (dist > 2.5) tiers.mid++;
      else tiers.short++;
    }
    if (tiers.long > 0) out.push({
      key: "aa_long", icon: Wind,
      label: `${t("ships.detail.weapon.aaGun")} ${t("ships.detail.weapon.aaLong")}`,
      detail: `${tiers.long} ${t("ships.detail.weapon.auras")}`, zone: "deck", count: tiers.long,
    });
    if (tiers.mid > 0) out.push({
      key: "aa_mid", icon: Wind,
      label: `${t("ships.detail.weapon.aaGun")} ${t("ships.detail.weapon.aaMid")}`,
      detail: `${tiers.mid} ${t("ships.detail.weapon.auras")}`, zone: "deck", count: tiers.mid,
    });
    if (tiers.short > 0) out.push({
      key: "aa_short", icon: Wind,
      label: `${t("ships.detail.weapon.aaGun")} ${t("ships.detail.weapon.aaShort")}`,
      detail: `${tiers.short} ${t("ships.detail.weapon.auras")}`, zone: "deck", count: tiers.short,
    });
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
