/**
 * Map-setup wizard (the tactics page's top-left map button): a two-step
 * HkStepFlow — pick the map (categorised list + live preview), then pick
 * the battle MODE for it (the same map hosts different cap layouts across
 * random / ranked / clan / operations). Emits the confirmed pair; the page
 * owns what happens next (session update, cap instantiation).
 */
import { computed, defineComponent, ref, watch, type PropType } from "vue";
import { HkModal, HkStepFlow, HkTabs, HkTag } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { displayMapName } from "@/utils/mapNames";
import { legacyMapOf, mapLineage } from "@/utils/legacyMaps";
import { resolveMapMinimapUrl } from "../modelLoader";
import { MODE_PRESETS, modePresetOf, type ModePreset } from "./modes";
import type { MapModeBucket } from "@/utils/mapModes";
import "./MapSetupModal.scss";

type CategoryKey = "all" | MapModeBucket;

const CATEGORIES: { key: CategoryKey; labelKey: string }[] = [
  { key: "all", labelKey: "tactics.filter.all" },
  { key: "random", labelKey: "tactics.filter.random" },
  { key: "ranked", labelKey: "tactics.filter.ranked" },
  { key: "clan", labelKey: "tactics.filter.clan" },
  { key: "pve", labelKey: "tactics.filter.pve" },
];

export default defineComponent({
  name: "TacticalMapSetupModal",
  props: {
    modelValue: { type: Boolean, required: true },
    /** Currently boarded map (pre-selected when the wizard opens). */
    currentMapId: { type: String as PropType<string | null>, default: null },
    currentModeId: { type: String as PropType<string | null>, default: null },
    /** Analysable space inventory (utils/tacticsMaps). */
    spaceIds: { type: Array as PropType<string[]>, required: true },
    /** Per-map mode buckets (observed replay history + fingerprints). */
    bucketsOf: {
      type: Function as PropType<(spaceId: string) => Set<MapModeBucket>>,
      required: true,
    },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    confirm: (_spaceId: string, _modeId: string) => true,
  },
  setup(props, { emit }) {
    const { dataLanguage } = useLanguage();
    const step = ref<"map" | "mode">("map");
    const category = ref<CategoryKey>("all");
    const mapId = ref<string | null>(props.currentMapId);
    const modeId = ref<string | null>(props.currentModeId);

    const steps = computed(() => [
      { key: "map", label: i18nT("tactics.setup.stepMap") },
      { key: "mode", label: i18nT("tactics.setup.stepMode") },
    ]);

    // A fresh wizard pass always starts on the map step with the current
    // selection preloaded — reopening to tweak the mode of the boarded map
    // is one click in, not a re-walk.
    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          step.value = "map";
          mapId.value = props.currentMapId;
          modeId.value = props.currentModeId;
        }
      },
    );

    const sortedMaps = computed(() => {
      const lang = dataLanguage.value;
      const f = category.value;
      return props.spaceIds
        .filter((id) => f === "all" || props.bucketsOf(id).has(f))
        .map((id) => ({ id, name: displayMapName(id, lang) }))
        .sort((a, b) => a.name.localeCompare(b.name, lang) || a.id.localeCompare(b.id))
        .map((e) => e.id);
    });

    /** Mode presets offered for the chosen map: its observed families first
     *  (a map only ever played in random battles fronts the random shapes),
     *  then the rest — any map CAN host any mode, the list just fronts the
     *  likely ones. */
    const presetOrder = computed<ModePreset[]>(() => {
      if (!mapId.value) return [...MODE_PRESETS];
      const fam = new Set(props.bucketsOf(mapId.value));
      const score = (m: ModePreset): number => (fam.has(m.family) ? 0 : 1);
      return [...MODE_PRESETS].sort(
        (a, b) => score(a) - score(b) || a.family.localeCompare(b.family),
      );
    });

    const previewUrl = computed(() => (mapId.value ? resolveMapMinimapUrl(mapId.value) : null));

    function chooseMap(id: string): void {
      mapId.value = id;
      step.value = "mode";
    }

    function confirm(): void {
      if (!mapId.value || !modeId.value) return;
      emit("confirm", mapId.value, modeId.value);
      emit("update:modelValue", false);
    }

    /** Cap template overlay for one preset over the preview art: normalised
     *  fractions map straight onto the square preview. */
    const capDots = computed(() => {
      const preset = modePresetOf(modeId.value);
      if (!preset) return [];
      return preset.caps.map((c) => ({
        letter: c.letter,
        left: `${c.at.x * 100}%`,
        top: `${(1 - c.at.z) * 100}%`,
        team: c.team ?? null,
      }));
    });

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={i18nT("tactics.setup.title")}
        width="min(66rem, 92vw)"
        footerActions={[
          step.value === "mode"
            ? {
                label: i18nT("tactics.setup.back"),
                variant: "secondary",
                onClick: () => (step.value = "map"),
              }
            : {
                label: i18nT("tactics.setup.cancel"),
                variant: "secondary",
                onClick: () => emit("update:modelValue", false),
              },
          {
            label: i18nT("tactics.setup.confirm"),
            variant: "primary",
            disabled: step.value === "map" ? mapId.value == null : modeId.value == null,
            onClick: confirm,
          },
        ]}
      >
        <HkStepFlow
          steps={steps.value}
          modelValue={step.value}
          timelineClickable
          onUpdate:modelValue={(v: string) => {
            if (v === "mode" && mapId.value == null) return;
            step.value = v as "map" | "mode";
          }}
          v-slots={{
            map: () => (
              <div class="map-setup">
                <div class="map-setup__browser">
                  <HkTabs
                    variant="segmented"
                    block
                    modelValue={category.value}
                    onUpdate:modelValue={(v: string) => (category.value = v as CategoryKey)}
                    tabs={CATEGORIES.map((c) => ({ key: c.key, label: i18nT(c.labelKey) }))}
                  />
                  <div class="map-setup__list">
                    {sortedMaps.value.length === 0 ? (
                      <p class="map-setup__empty">{i18nT("tactics.list.filterEmpty")}</p>
                    ) : (
                      sortedMaps.value.map((id) => (
                        <button
                          key={id}
                          type="button"
                          class={[
                            "map-setup__item",
                            mapId.value === id ? "map-setup__item--on" : "",
                          ]}
                          onClick={() => chooseMap(id)}
                        >
                          <span class="map-setup__item-name">
                            {displayMapName(id, dataLanguage.value)}
                          </span>
                          <span class="map-setup__item-id">{id}</span>
                          {mapLineage(id) === "legacy" ? (
                            <HkTag size="sm" variant="warning">
                              {i18nT("tactics.badge.legacy")}
                            </HkTag>
                          ) : null}
                        </button>
                      ))
                    )}
                  </div>
                </div>
                <div class="map-setup__preview">
                  {previewUrl.value ? (
                    <img class="map-setup__art" src={previewUrl.value} alt="" draggable={false} />
                  ) : (
                    <div class="map-setup__art map-setup__art--empty" />
                  )}
                  {mapId.value ? (
                    <div class="map-setup__meta">
                      <strong>{displayMapName(mapId.value, dataLanguage.value)}</strong>
                      <span>{mapId.value}</span>
                      {legacyMapOf(mapId.value) ? (
                        <span class="map-setup__meta-note">{i18nT("tactics.badge.legacy")}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ),
            mode: () => (
              <div class="map-setup">
                <div class="map-setup__modes">
                  {presetOrder.value.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      class={[
                        "map-setup__mode",
                        modeId.value === preset.id ? "map-setup__mode--on" : "",
                      ]}
                      onClick={() => (modeId.value = preset.id)}
                    >
                      <span class="map-setup__mode-head">
                        <strong>{i18nT(`tactics.mode.${preset.labelKey}`)}</strong>
                        <HkTag size="sm">
                          {preset.caps.length > 0
                            ? i18nT("tactics.setup.capCount", { n: preset.caps.length })
                            : i18nT("tactics.setup.capNone")}
                        </HkTag>
                      </span>
                      <span class="map-setup__mode-desc">
                        {i18nT(`tactics.mode.${preset.descKey}`)}
                      </span>
                    </button>
                  ))}
                </div>
                <div class="map-setup__preview">
                  {previewUrl.value ? (
                    <div class="map-setup__art-wrap">
                      <img class="map-setup__art" src={previewUrl.value} alt="" draggable={false} />
                      {capDots.value.map((c) => (
                        <span
                          key={c.letter}
                          class={[
                            "map-setup__cap",
                            c.team === "ally"
                              ? "map-setup__cap--ally"
                              : c.team === "enemy"
                                ? "map-setup__cap--enemy"
                                : "",
                          ]}
                          style={{ left: c.left, top: c.top }}
                        >
                          {c.letter}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {modePresetOf(modeId.value) ? (
                    <div class="map-setup__meta">
                      <strong>{i18nT(`tactics.mode.${modePresetOf(modeId.value)!.labelKey}`)}</strong>
                      <span>
                        {i18nT("tactics.setup.duration", {
                          m: Math.round(modePresetOf(modeId.value)!.durationS / 60),
                        })}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            ),
          }}
        />
      </HkModal>
    );
  },
});
