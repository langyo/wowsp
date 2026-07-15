import { computed, defineComponent, ref, watch, type PropType } from "vue";
import { RotateCcw, Lock } from "lucide-vue-next";

import SButton from "@/components/base/SButton";
import { t } from "@/i18n";
import { resolveSkillIcon } from "@/utils/skillIcons";
import {
  SKILL_TREES,
  SKILL_BUDGET,
  TIER_UNLOCK,
  skillClassFor,
  skillDisplayName,
  type Skill,
  type SkillClass,
} from "./skillTree";
import "./SkillBuilder.scss";

/**
 * Captain skill-point planner — redesigned as a 3-column layout matching
 * the in-game (and 浩舰) captain panel:
 *   Left:  Equipment / Upgrades (placeholder)
 *   Center: Captain skill tree (4 tiers stacked vertically, skills in rows)
 *   Right: Signal Flags (placeholder)
 *
 * The skill section renders a compact vertical view: one row per tier, each
 * skill displayed as a hexagonal icon with rank dots. Tier unlock rules are
 * enforced (tier N requires ≥N-1 points in lower tiers). Total 21-pt budget.
 */
export default defineComponent({
  name: "SkillBuilder",
  props: {
    shipType: { type: String, required: true },
    modelRank: { type: Object as PropType<Record<string, number>>, default: undefined },
  },
  emits: {
    "update:modelRank": (_v: Record<string, number>) => true,
  },
  setup(props, { emit }) {
    const cls = computed<SkillClass>(() => skillClassFor(props.shipType));
    const tree = computed(() => SKILL_TREES[cls.value] ?? []);
    const internalRank = ref<Record<string, number>>({});

    const rank = computed(() => props.modelRank ?? internalRank.value);

    function setRank(next: Record<string, number>) {
      if (props.modelRank !== undefined) emit("update:modelRank", next);
      else internalRank.value = next;
    }

    watch(cls, () => { internalRank.value = {}; }, { immediate: true });

    const usedPoints = computed(() =>
      Object.values(rank.value).reduce((sum, r) => sum + r, 0),
    );
    const remaining = computed(() => SKILL_BUDGET - usedPoints.value);
    const overBudget = computed(() => remaining.value < 0);

    function pointsBelowTier(tier: number): number {
      return tree.value
        .filter((s) => s.tier < tier)
        .reduce((sum, s) => sum + (rank.value[s.name] ?? 0), 0);
    }

    function tierUnlocked(tier: number): boolean {
      if (tier === 1) return true;
      const need = TIER_UNLOCK[tier as 2 | 3 | 4];
      return pointsBelowTier(tier) >= need;
    }

    function canInc(name: string, maxRank: number): boolean {
      if ((rank.value[name] ?? 0) >= maxRank) return false;
      return remaining.value > 0;
    }

    function inc(skill: Skill): void {
      if (!canInc(skill.name, skill.maxRank)) return;
      const next = { ...rank.value, [skill.name]: (rank.value[skill.name] ?? 0) + 1 };
      setRank(next);
    }

    function dec(name: string): void {
      const cur = rank.value[name] ?? 0;
      if (cur <= 0) return;
      const next: Record<string, number> = { ...rank.value, [name]: cur - 1 };
      if (next[name] === 0) delete next[name];
      setRank(next);
    }

    function reset(): void { setRank({}); }

    const tiers = computed(() => {
      const out: Record<number, Skill[]> = { 1: [], 2: [], 3: [], 4: [] };
      for (const s of tree.value) out[s.tier].push(s);
      return out;
    });

    return () => {
      if (tree.value.length === 0) {
        return <p class="skill-builder-v__empty">{t("ships.skills.noTree")}</p>;
      }
      return (
        <div class="skill-builder-v">
          {/* ── Top bar: point counter + reset ── */}
          <div class="skill-builder-v__bar">
            <span
              class={["skill-builder-v__points", overBudget.value ? "skill-builder-v__points--over" : ""]}
            >
              {t("ships.skills.pointsUsed", { used: usedPoints.value, max: SKILL_BUDGET })}
            </span>
            {remaining.value >= 0
              ? <span class="skill-builder-v__remaining">{t("ships.skills.remaining", { n: remaining.value })}</span>
              : <span class="skill-builder-v__remaining skill-builder-v__points--over">{t("ships.skills.overBudget")}</span>}
            <SButton variant="ghost" size="sm" onClick={reset}>
              <RotateCcw size={12} /> {t("ships.skills.reset")}
            </SButton>
          </div>

          {/* ── 3-column layout ── */}
          <div class="skill-builder-v__columns">
            {/* Left: Equipment placeholder */}
            <div class="skill-builder-v__equip">
              <div class="skill-builder-v__placeholder">
                <span class="skill-builder-v__placeholder-icon">⚙</span>
                <span class="skill-builder-v__placeholder-text">{t("ships.skills.equipment", {})}</span>
              </div>
            </div>

            {/* Center: Captain skills — vertical tiers, skills in rows */}
            <div class="skill-builder-v__skills">
              {[1, 2, 3, 4].map((tier) => {
                const unlocked = tierUnlocked(tier);
                const need = tier === 1 ? 0 : TIER_UNLOCK[tier as 2 | 3 | 4];
                return (
                  <div
                    class={["skill-tier-v", unlocked ? "" : "skill-tier-v--locked"]}
                    key={tier}
                  >
                    <div class="skill-tier-v__label">
                      <span>{t("ships.skills.tier", { n: tier })}</span>
                      {!unlocked ? (
                        <span class="skill-tier-v__lock" title={t("ships.skills.locked", { n: need })}>
                          <Lock size={10} />
                        </span>
                      ) : null}
                    </div>
                    <div class="skill-tier-v__row">
                      {tiers.value[tier].map((skill) => {
                        const r = rank.value[skill.name] ?? 0;
                        const canI = unlocked && canInc(skill.name, skill.maxRank);
                        const iconUrl = resolveSkillIcon(skill.icon);
                        const displayName = skillDisplayName(skill.name);
                        return (
                          <div
                            class={["skill-tile-v", r > 0 ? "skill-tile-v--active" : ""]}
                            key={skill.name}
                          >
                            <button
                              type="button"
                              class="skill-tile-v__btn"
                              disabled={!unlocked}
                              onClick={() => (unlocked ? inc(skill) : null)}
                              title={displayName}
                            >
                              <span class="skill-tile-v__icon">
                                {iconUrl ? (
                                  <img class="skill-tile-v__icon-img" src={iconUrl} alt={displayName} draggable={false} />
                                ) : (
                                  displayName.charAt(0)
                                )}
                              </span>
                            </button>
                            <span class="skill-tile-v__name">{displayName}</span>
                            <div class="skill-tile-v__pips">
                              {Array.from({ length: skill.maxRank }, (_, i) => (
                                <button
                                  type="button"
                                  class={["skill-tile-v__pip", i < r ? "skill-tile-v__pip--on" : ""]}
                                  disabled={!unlocked || (i >= r ? !canI : false)}
                                  onClick={() => (i >= r ? inc(skill) : dec(skill.name))}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Right: Flags placeholder */}
            <div class="skill-builder-v__flags">
              <div class="skill-builder-v__placeholder">
                <span class="skill-builder-v__placeholder-icon">🏴</span>
                <span class="skill-builder-v__placeholder-text">{t("ships.skills.flags", {})}</span>
              </div>
            </div>
          </div>
        </div>
      );
    };
  },
});
