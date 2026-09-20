import { computed, defineComponent, ref, type PropType } from "vue";
import { Shield, Crosshair, Target, Plane, Gauge, Eye, HelpCircle } from "@lucide/vue";

import { HIconButtonGroup } from "@celestia-island/hikari";
import { buildShipSpecs } from "./shipSpecs";
import { recomputeStats, type ModifiedStats, type PlannerBuild } from "./modifierPipeline";
import { t } from "@/i18n";
import type { ShipInfo } from "@/api";
import "./DataObserver.scss";

/**
 * Data Observer — the build planner's 综合属性 stats panel. Shows how the
 * ship's base specs change after applying the current build (skills + flags +
 * upgrades) at the selected HP level.
 *
 * One category is visible at a time, picked via an HIconButtonGroup strip —
 * the panel is only 300px wide, so stacking every group made it an endless
 * scroll. buildShipSpecs already omits empty groups (destroyers get no
 * Anti-Air block), so the selector only ever offers what THIS ship has.
 *
 * Each stat is displayed as:
 *   基础值  ±Δ  =  最终值
 *   base_value ± delta = modified_value
 *
 * Groups mirror the SpecsPanel layout (Survivability / Main Battery / etc.)
 * but with per-stat delta annotations. Stats that don't change show as-is.
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

export default defineComponent({
  name: "DataObserver",
  props: {
    ship: { type: Object as PropType<ShipInfo>, required: true },
    build: { type: Object as PropType<PlannerBuild>, required: true },
    /** Raw GameParams entry (lazy-fetched by the modal) — feeds the
     *  per-band AA rows; null keeps the AA group absent. */
    gameparams: { type: Object as PropType<Record<string, unknown> | null>, default: null },
  },
  setup(props) {
    const profile = computed(() => (props.ship.defaultProfile ?? {}) as Record<string, any>);

    const stats = computed(() =>
      recomputeStats(profile.value, props.ship.type, props.ship.tier, props.build, props.build.healthPct),
    );

    /**
     * Build observer rows: take the base spec groups and enrich the numeric
     * rows with modified values + delta formatting where applicable.
     */
    const observerGroups = computed(() => {
      // computeDelta has no cases for the new per-band AA row keys — those
      // rows render statically, exactly like the old rating row did.
      const groups = buildShipSpecs(profile.value, props.ship.nation, props.gameparams);
      if (groups.length === 0) return [];
      const { base, modified } = stats.value;
      return groups.map((g) => ({
        ...g,
        rows: g.rows.map((row) => {
          const delta = computeDelta(row.key, profile.value, base, modified);
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

    // ── Category selector ─────────────────────────────────────────────────
    // The raw selection lives in a ref; the effective key guards against a
    // stale value after the ship changed (category gone from the list →
    // fall back to the first one, no warnings).
    const activeGroup = ref<string | null>(null);
    const activeKey = computed(() => {
      const groups = observerGroups.value;
      if (activeGroup.value != null && groups.some((g) => g.group === activeGroup.value)) {
        return activeGroup.value;
      }
      return groups[0]?.group ?? null;
    });
    const visibleGroup = computed(
      () => observerGroups.value.find((g) => g.group === activeKey.value) ?? null,
    );

    return () => {
      // The label doubles as the built-in tooltip; the icon is the same
      // lucide glyph the group header uses.
      const options = observerGroups.value.map((g) => {
        const Icon = iconFor(g.icon);
        return { key: g.group, label: t(`ships.spec.group.${g.group}`), icon: <Icon size={13} /> };
      });
      const visible = visibleGroup.value;
      const VisibleIcon = visible ? iconFor(visible.icon) : null;
      return (
        <div class="data-observer">
          {options.length > 0 ? (
            <HIconButtonGroup
              mode="single"
              size="sm"
              options={options}
              modelValue={activeKey.value}
              onUpdate:modelValue={(v: string | string[]) => {
                activeGroup.value = v as string;
              }}
            />
          ) : null}
          {visible ? (
            <section class="do-group" key={visible.group}>
              <header class="do-group__head">
                {VisibleIcon ? <VisibleIcon size={13} /> : null}
                <h5 class="do-group__title">{t(`ships.spec.group.${visible.group}`)}</h5>
              </header>
              <dl class="do-group__rows">
                {visible.rows.map((row) => (
                  <div
                    class={["do-group__row", row.changed ? "do-group__row--changed" : ""]}
                    key={row.key}
                  >
                    <dt class="do-group__label">
                      {t(`ships.spec.${row.key}`)}
                      {row.hint ? (
                        <span class="do-group__hint" data-hint={t(`ships.spec.${row.hint}`)}>
                          <HelpCircle size={10} />
                        </span>
                      ) : null}
                    </dt>
                    <dd class="do-group__value">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </div>
      );
    };
  },
});

/** Compute a delta-formatted value string for a spec row key, or null if
 *  the stat isn't affected by modifiers. */
function computeDelta(
  key: string,
  profile: Record<string, any>,
  base: ModifiedStats,
  modified: ModifiedStats,
): string | null {
  const p = profile as Record<string, any>;
  const art = p.artillery as Record<string, any> | undefined;
  const hull = p.hull as Record<string, any> | undefined;

  switch (key) {
    case "hp": {
      if (base.hp == null || modified.hp == null) return null;
      return fmtDeltaInt(base.hp, modified.hp, "");
    }
    case "mainGunReload": {
      if (base.reload == null || modified.reload == null) return null;
      return fmtDelta(base.reload, modified.reload, 1, " s");
    }
    case "mainGunRange": {
      if (base.range == null || modified.range == null) return null;
      return fmtDelta(base.range, modified.range, 1, " km");
    }
    case "turretTraverse": {
      if (base.traverse == null || modified.traverse == null) return null;
      return fmtDelta(base.traverse, modified.traverse, 1, " s / 180°");
    }
    case "surfaceDetect": {
      if (base.concealmentShip == null || modified.concealmentShip == null) return null;
      return fmtDelta(base.concealmentShip, modified.concealmentShip, 1, " km");
    }
    case "maxSpeed": {
      if (base.speed == null || modified.speed == null) return null;
      return fmtDelta(base.speed, modified.speed, 1, " kn");
    }
    case "torpSpeed": {
      if (base.torpedoSpeed == null || modified.torpedoSpeed == null) return null;
      return fmtDelta(base.torpedoSpeed, modified.torpedoSpeed, 0, " kn");
    }
    case "torpReload": {
      if (base.torpedoReload == null || modified.torpedoReload == null) return null;
      return fmtDelta(base.torpedoReload, modified.torpedoReload, 1, " s");
    }
    case "rudderShift": {
      if (base.rudderShift == null || modified.rudderShift == null) return null;
      return fmtDelta(base.rudderShift, modified.rudderShift, 1, " s");
    }
    case "heFireChance": {
      if (base.fireChanceOut == null || modified.fireChanceOut == null) return null;
      return fmtDelta(base.fireChanceOut, modified.fireChanceOut, 0, "%");
    }
    // DPM: recompute from modified reload
    case "heDpm":
    case "apDpm": {
      const baseReload = base.reload;
      if (baseReload == null) return null;
      const barrels = num(hull?.artillery_barrels);
      if (barrels == null) return null;
      const shells = art?.shells as Record<string, any> | undefined;
      const isHe = key === "heDpm";
      const dmg = num(shells?.[isHe ? "HE" : "AP"]?.damage);
      if (dmg == null) return null;
      const baseDpm = (dmg * barrels) / baseReload;
      const modReload = modified.reload ?? baseReload;
      if (modReload === baseReload) return `${Math.round(baseDpm).toLocaleString()}`;
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
