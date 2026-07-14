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
 * Captain skill-point planner for a ship. Renders the class-appropriate
 * 4-tier tree, lets the player invest / refund points within a fixed 21-pt
 * budget, and enforces the per-tier unlock rule (tier N needs ≥ N-1 points in
 * lower tiers). No stat deltas are computed — this is a planning aid only.
 *
 * Allocation state is `Record<skillId, rank>`; the builder recomputes the
 * running totals and lock state on every change.
 */
export default defineComponent({
  name: "SkillBuilder",
  props: {
    shipType: { type: String, required: true },
    /** Optional externally-controlled allocation. When provided, the builder
     *  becomes controlled (emits `update:modelRank` instead of mutating an
     *  internal ref) so a parent like the shipyard can share the state. */
    modelRank: { type: Object as PropType<Record<string, number>>, default: undefined },
  },
  emits: {
    "update:modelRank": (_v: Record<string, number>) => true,
  },
  setup(props, { emit }) {
    const cls = computed<SkillClass>(() => skillClassFor(props.shipType));
    const tree = computed(() => SKILL_TREES[cls.value] ?? []);
    // Internal allocation (used when no modelRank is passed — the standalone
    // skill tab). For controlled usage the parent's ref is the source of truth.
    const internalRank = ref<Record<string, number>>({});

    /** The active allocation: external if provided, else internal. */
    const rank = computed(() => props.modelRank ?? internalRank.value);

    /** Write an allocation, routing to the external emit when controlled. */
    function setRank(next: Record<string, number>) {
      if (props.modelRank !== undefined) emit("update:modelRank", next);
      else internalRank.value = next;
    }

    // Reset the INTERNAL allocation whenever the tree (ship class) changes.
    // (Controlled mode leaves reset to the parent.)
    watch(
      cls,
      () => {
        internalRank.value = {};
      },
      { immediate: true },
    );

    const usedPoints = computed(() =>
      Object.values(rank.value).reduce((sum, r) => sum + r, 0),
    );
    const remaining = computed(() => SKILL_BUDGET - usedPoints.value);
    const overBudget = computed(() => remaining.value < 0);

    /** Points spent in tiers strictly below `tier`. */
    function pointsBelowTier(tier: number): number {
      return tree.value
        .filter((s) => s.tier < tier)
        .reduce((sum, s) => sum + (rank.value[s.name] ?? 0), 0);
    }

    /** A tier is unlocked when enough points sit in the tiers below it. */
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
    function reset(): void {
      setRank({});
    }

    /** Group skills by tier (1..4) for column rendering. */
    const tiers = computed(() => {
      const out: Record<number, Skill[]> = { 1: [], 2: [], 3: [], 4: [] };
      for (const s of tree.value) out[s.tier].push(s);
      return out;
    });

    return () => {
      if (tree.value.length === 0) {
        return <p class="skill-builder__empty">{t("ships.skills.noTree")}</p>;
      }
      return (
        <div class="skill-builder">
          <div class="skill-builder__bar">
            <span
              class={[
                "skill-builder__points",
                overBudget.value ? "skill-builder__points--over" : "",
              ]}
            >
              {t("ships.skills.pointsUsed", {
                used: usedPoints.value,
                max: SKILL_BUDGET,
              })}
            </span>
            {remaining.value >= 0
              ? <span class="skill-builder__remaining">{t("ships.skills.remaining", { n: remaining.value })}</span>
              : <span class="skill-builder__remaining skill-builder__points--over">{t("ships.skills.overBudget")}</span>}
            <SButton variant="ghost" size="sm" onClick={reset}>
              <RotateCcw size={12} /> {t("ships.skills.reset")}
            </SButton>
          </div>

          <div class="skill-builder__grid">
            {[1, 2, 3, 4].map((tier) => {
              const unlocked = tierUnlocked(tier);
              const need = tier === 1 ? 0 : TIER_UNLOCK[tier as 2 | 3 | 4];
              return (
                <div class={["skill-builder__tier", unlocked ? "" : "skill-builder__tier--locked"]}>
                  <div class="skill-builder__tier-head">
                    <span>{t("ships.skills.tier", { n: tier })}</span>
                    {!unlocked ? (
                      <span class="skill-builder__lock" title={t("ships.skills.locked", { n: need })}>
                        <Lock size={11} />
                      </span>
                    ) : null}
                  </div>
                  <div class="skill-builder__skills">
                    {tiers.value[tier].map((skill) => {
                      const r = rank.value[skill.name] ?? 0;
                      const filled = unlocked && r > 0;
                      const canI = unlocked && canInc(skill.name, skill.maxRank);
                      const iconUrl = resolveSkillIcon(skill.icon);
                      const displayName = skillDisplayName(skill.name);
                      return (
                        <div
                          class={[
                            "skill-skill",
                            filled ? "skill-skill--filled" : "",
                            unlocked ? "" : "skill-skill--dim",
                          ]}
                        >
                          <button
                            type="button"
                            class="skill-skill__inc"
                            disabled={!canI}
                            onClick={() => inc(skill)}
                            title={displayName}
                          >
                            <span class="skill-skill__icon">
                              {iconUrl ? (
                                <img class="skill-skill__icon-img" src={iconUrl} alt={displayName} draggable={false} />
                              ) : (
                                displayName.charAt(0)
                              )}
                            </span>
                            <span class="skill-skill__name">{displayName}</span>
                          </button>
                          <div class="skill-skill__ranks">
                            {Array.from({ length: skill.maxRank }, (_, i) => (
                              <button
                                type="button"
                                class={[
                                  "skill-skill__pip",
                                  i < r ? "skill-skill__pip--on" : "",
                                ]}
                                disabled={!unlocked || (i >= r ? !canI : false)}
                                onClick={() => (i >= r ? inc(skill) : dec(skill.name))}
                                aria-label={t("ships.skills.rank", { n: i + 1 })}
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
        </div>
      );
    };
  },
});
