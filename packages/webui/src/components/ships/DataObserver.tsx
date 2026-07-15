import { computed, defineComponent, type PropType } from "vue";
import { Shield, Crosshair, Target, Plane, Gauge, Eye, HelpCircle } from "lucide-vue-next";

import { buildShipSpecs } from "./shipSpecs";
import { recomputeStats } from "./modifierPipeline";
import { skillClassFor } from "./skillTree";
import { t } from "@/i18n";
import type { ShipInfo } from "@/api";
import "./DataObserver.scss";

/**
 * Data Observer panel — replaces the 2D/3D portrait at the top of the captain
 * skills tab (equipment / skills / flags). Shows how the ship's base specs
 * change after applying equipment + captain skills + signal flags.
 *
 * Each stat is displayed as:
 *   基础值  ±Δ  =  最终值
 *   base_value ± delta = modified_value
 *
 * Groups mirror the SpecsPanel layout (Survivability / Main Battery / etc.)
 * but with per-stat delta annotations. Stats that don't change show as-is.
 *
 * The stats actually affected are: HP, reload, range, traverse, concealment,
 * speed, torpedo speed, HE pen, HE/AP damage, fire chance. Derived DPM values
 * are recomputed from modified reload.
 */

/** Numeric stat delta helpers. */
function fmtDelta(base: number, mod: number, decimals: number, suffix: string): string {
  const diff = mod - base;
  if (Math.abs(diff) < 0.001) return `${base.toFixed(decimals)}${suffix}`;
  const sign = diff >= 0 ? "+" : "−";
  return `${base.toFixed(decimals)} ${sign}${Math.abs(diff).toFixed(decimals)} = ${mod.toFixed(decimals)}${suffix}`;
}

function fmtDeltaInt(base: number, mod: number, suffix: string): string {
  const b = Math.round(base);
  const m = Math.round(mod);
  const diff = m - b;
  if (diff === 0) return `${b}${suffix}`;
  const sign = diff >= 0 ? "+" : "−";
  return `${b} ${sign}${Math.abs(diff)} = ${m}${suffix}`;
}

/** Return a modified reload value factoring any skill multiplier. */
function modifiedReload(profile: Record<string, any>, rank: Record<string, number>, cls: string, healthPct: number): number | null {
  const stats = recomputeStats(profile, cls, rank, healthPct);
  return stats.modified.reload;
}

function modifiedRange(profile: Record<string, any>, rank: Record<string, number>, cls: string, healthPct: number): number | null {
  const stats = recomputeStats(profile, cls, rank, healthPct);
  return stats.modified.range;
}

function modifiedTraverse(profile: Record<string, any>, rank: Record<string, number>, cls: string, healthPct: number): number | null {
  const stats = recomputeStats(profile, cls, rank, healthPct);
  return stats.modified.traverse;
}

function modifiedHp(profile: Record<string, any>, rank: Record<string, number>, cls: string, healthPct: number): number | null {
  const stats = recomputeStats(profile, cls, rank, healthPct);
  return stats.modified.hp;
}

function modifiedConceal(profile: Record<string, any>, rank: Record<string, number>, cls: string, healthPct: number): number | null {
  const stats = recomputeStats(profile, cls, rank, healthPct);
  return stats.modified.concealmentShip;
}

function modifiedSpeed(profile: Record<string, any>, rank: Record<string, number>, cls: string, healthPct: number): number | null {
  const stats = recomputeStats(profile, cls, rank, healthPct);
  return stats.modified.speed;
}

function modifiedTorpedoSpeed(profile: Record<string, any>, rank: Record<string, number>, cls: string, healthPct: number): number | null {
  const stats = recomputeStats(profile, cls, rank, healthPct);
  return stats.modified.torpedoSpeed;
}

export default defineComponent({
  name: "DataObserver",
  props: {
    ship: { type: Object as PropType<ShipInfo>, required: true },
    rank: { type: Object as PropType<Record<string, number>>, required: true },
    healthPct: { type: Number, default: 1 },
  },
  setup(props) {
    const profile = computed(() => (props.ship.defaultProfile ?? {}) as Record<string, any>);
    const cls = computed(() => skillClassFor(props.ship.type));
    const nation = computed(() => props.ship.nation);

    /**
     * Build observer rows: take the base spec groups and enrich the numeric
     * rows with modified values + delta formatting where applicable.
     */
    const observerGroups = computed(() => {
      const groups = buildShipSpecs(profile.value, nation.value);
      const p = profile.value;
      const rank = props.rank;
      const hp = props.healthPct;

      if (groups.length === 0) return [];

      return groups.map((g) => ({
        ...g,
        rows: g.rows.map((row) => {
          const delta = computeDelta(row.key, p, rank, cls.value, hp);
          if (delta) {
            return {
              ...row,
              value: delta,
              changed: delta.includes(" = "),
            };
          }
          return { ...row, changed: false };
        }),
      }));
    });

    const iconFor = (name: string) => {
      switch (name) {
        case "Shield": return Shield;
        case "Crosshair": return Crosshair;
        case "Target": return Target;
        case "Plane": return Plane;
        case "Gauge": return Gauge;
        case "Eye": return Eye;
        default: return Shield;
      }
    };

    return () => (
      <div class="data-observer">
        <div class="data-observer__grid">
          {observerGroups.value.map((g) => {
            const Icon = iconFor(g.icon);
            return (
              <section class="do-group" key={g.group}>
                <header class="do-group__head">
                  <Icon size={13} />
                  <h5 class="do-group__title">{t(`ships.spec.group.${g.group}`)}</h5>
                </header>
                <dl class="do-group__rows">
                  {g.rows.map((row) => (
                    <div
                      class={["do-group__row", row.changed ? "do-group__row--changed" : ""]}
                      key={row.key}
                    >
                      <dt class="do-group__label">
                        {t(`ships.spec.${row.key}`)}
                        {row.hint ? (
                          <span class="do-group__hint" title={t(`ships.spec.${row.hint}`)}>
                            <HelpCircle size={10} />
                          </span>
                        ) : null}
                      </dt>
                      <dd class="do-group__value">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </div>
    );
  },
});

/** Compute a delta-formatted value string for a spec row key, or null if
 *  the stat isn't affected by modifiers. */
function computeDelta(
  key: string,
  profile: Record<string, any>,
  rank: Record<string, number>,
  cls: string,
  healthPct: number,
): string | null {
  const p = profile as Record<string, any>;
  const art = p.artillery as Record<string, any> | undefined;
  const hull = p.hull as Record<string, any> | undefined;
  const mob = p.mobility as Record<string, any> | undefined;
  const con = p.concealment as Record<string, any> | undefined;
  const torp = p.torpedoes as Record<string, any> | undefined;

  const baseReload = num(art?.shot_delay);
  const baseRange = num(art?.distance);
  const baseTraverse = num(art?.rotation_time);
  const baseSpeed = num(mob?.max_speed);
  const baseConceal = num(con?.detect_distance_by_ship);
  const baseHp = num(hull?.health);
  const baseTorpedoSpeed = num(torp?.torpedo_speed);

  switch (key) {
    case "hp": {
      if (baseHp == null) return null;
      const mod = modifiedHp(profile, rank, cls, healthPct);
      if (mod == null) return `${baseHp.toLocaleString()}`;
      return fmtDeltaInt(baseHp, mod, "");
    }
    case "mainGunReload": {
      if (baseReload == null) return null;
      const mod = modifiedReload(profile, rank, cls, healthPct);
      if (mod == null) return `${baseReload.toFixed(1)} s`;
      return fmtDelta(baseReload, mod, 1, " s");
    }
    case "mainGunRange": {
      if (baseRange == null) return null;
      const mod = modifiedRange(profile, rank, cls, healthPct);
      if (mod == null) return `${baseRange.toFixed(1)} km`;
      return fmtDelta(baseRange, mod, 1, " km");
    }
    case "turretTraverse": {
      if (baseTraverse == null) return null;
      const mod = modifiedTraverse(profile, rank, cls, healthPct);
      if (mod == null) return `${baseTraverse.toFixed(1)} s / 180°`;
      return fmtDelta(baseTraverse, mod, 1, " s / 180°");
    }
    case "surfaceDetect": {
      if (baseConceal == null) return null;
      const mod = modifiedConceal(profile, rank, cls, healthPct);
      if (mod == null) return `${baseConceal.toFixed(1)} km`;
      return fmtDelta(baseConceal, mod, 1, " km");
    }
    case "maxSpeed": {
      if (baseSpeed == null) return null;
      const mod = modifiedSpeed(profile, rank, cls, healthPct);
      if (mod == null) return `${baseSpeed.toFixed(1)} kn`;
      return fmtDelta(baseSpeed, mod, 1, " kn");
    }
    case "torpSpeed": {
      if (baseTorpedoSpeed == null) return null;
      const mod = modifiedTorpedoSpeed(profile, rank, cls, healthPct);
      if (mod == null) return `${baseTorpedoSpeed} kn`;
      return fmtDelta(baseTorpedoSpeed, mod, 0, " kn");
    }
    // DPM: recompute from modified reload
    case "heDpm":
    case "apDpm": {
      if (baseReload == null) return null;
      const barrels = num(hull?.artillery_barrels);
      if (barrels == null) return null;
      const shells = art?.shells as Record<string, any> | undefined;
      const isHe = key === "heDpm";
      const dmg = num(shells?.[isHe ? "HE" : "AP"]?.damage);
      if (dmg == null) return null;
      const baseDpm = (dmg * barrels) / baseReload;
      const modReload = modifiedReload(profile, rank, cls, healthPct);
      if (modReload == null || modReload === baseReload) return `${Math.round(baseDpm).toLocaleString()}`;
      const modDpm = (dmg * barrels) / modReload;
      return fmtDeltaInt(Math.round(baseDpm), Math.round(modDpm), "");
    }
    default:
      return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
