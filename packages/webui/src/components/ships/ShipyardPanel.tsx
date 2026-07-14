import { computed, defineComponent, type PropType } from "vue";

import SkillBuilder from "./SkillBuilder";
import { recomputeStats } from "./modifierPipeline";
import { skillClassFor } from "./skillTree";
import { t } from "@/i18n";
import type { ShipInfo } from "@/api";
import "./ShipyardPanel.scss";

/** Format a number with fixed decimals, locale-grouped. */
function fmt(v: number, decimals = 1): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Shipyard panel — the live stat-recomputation view. Left: the captain skill
 * tree (SkillBuilder) + a current-HP slider (drives Adrenaline-Rush-type
 * trigger skills). Right: a before/after stat comparison showing exactly how
 * the selected skills + HP change the ship's numbers (HP, reload, range, etc.).
 *
 * The skill allocation + HP live in the parent (ShipDetailModal) so switching
 * tabs preserves them; this panel just renders from the shared state.
 */
export default defineComponent({
  name: "ShipyardPanel",
  props: {
    ship: { type: Object as PropType<ShipInfo>, required: true },
    /** Skill allocation { displayName: rank }, shared with SkillBuilder. */
    rank: { type: Object as PropType<Record<string, number>>, required: true },
    /** Current HP fraction 0..1 (drives trigger skills). */
    healthPct: { type: Number, required: true },
  },
  emits: {
    "update:rank": (_v: Record<string, number>) => true,
    "update:healthPct": (_v: number) => true,
  },
  setup(props, { emit }) {
    const cls = computed(() => skillClassFor(props.ship.type));
    const profile = computed(() => (props.ship.defaultProfile ?? {}) as Record<string, unknown>);

    const stats = computed(() =>
      recomputeStats(profile.value, cls.value, props.rank, props.healthPct),
    );

    /** Stat rows for the comparison table. Each shows base → modified with a
     *  delta highlight when they differ. */
    const rows = computed(() => {
      const { base, modified } = stats.value;
      type Row = { key: string; base: string; mod: string; changed: boolean };
      const out: Row[] = [];
      const push = (key: string, b: number | null, m: number | null, unit: string, decimals = 1) => {
        out.push({
          key,
          base: b != null ? `${fmt(b, decimals)}${unit}` : "—",
          mod: m != null ? `${fmt(m, decimals)}${unit}` : "—",
          changed: b != null && m != null && Math.abs(m - b) > 0.001,
        });
      };
      push("hp", base.hp, modified.hp, "", 0);
      push("reload", base.reload, modified.reload, "s");
      push("range", base.range, modified.range, "km");
      push("traverse", base.traverse, modified.traverse, "s");
      push("concealment", base.concealmentShip, modified.concealmentShip, "km");
      push("speed", base.speed, modified.speed, "kn", 0);
      push("torpedoSpeed", base.torpedoSpeed, modified.torpedoSpeed, "kn", 0);
      return out;
    });

    function setRank(r: Record<string, number>) {
      emit("update:rank", r);
    }

    return () => (
      <div class="shipyard">
        <div class="shipyard__left">
          <SkillBuilder
            shipType={props.ship.type}
            modelRank={props.rank}
            onUpdate:modelRank={(r: Record<string, number>) => setRank(r)}
          />
          <div class="shipyard__hp">
            <label class="shipyard__hp-label">
              {t("ships.shipyard.healthSlider")}:
              <strong>{Math.round(props.healthPct * 100)}%</strong>
            </label>
            <input
              class="shipyard__hp-slider"
              type="range"
              min={1}
              max={100}
              step={1}
              value={Math.round(props.healthPct * 100)}
              onInput={(e) => emit("update:healthPct", Number((e.target as HTMLInputElement).value) / 100)}
            />
            <span class="shipyard__hp-hint">{t("ships.shipyard.healthHint")}</span>
          </div>
        </div>
        <div class="shipyard__right">
          <h4 class="shipyard__title">{t("ships.shipyard.modifiedStats")}</h4>
          <table class="shipyard__table">
            <thead>
              <tr>
                <th>{t("ships.shipyard.stat")}</th>
                <th>{t("ships.shipyard.base")}</th>
                <th>{t("ships.shipyard.modified")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.value.map((r) => (
                <tr key={r.key} class={r.changed ? "shipyard__row--changed" : ""}>
                  <td>{t(`ships.shipyard.stats.${r.key}`, {})}</td>
                  <td class="shipyard__cell-base">{r.base}</td>
                  <td class={r.changed ? "shipyard__cell-mod" : ""}>{r.mod}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
});
