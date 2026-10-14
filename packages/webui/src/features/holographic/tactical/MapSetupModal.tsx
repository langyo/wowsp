/**
 * Map-setup wizard (the tactics page's top-left map button): a two-step
 * HkStepFlow — pick the map (categorised list + live preview, advanced to
 * step 2 ONLY by the explicit next button), then pick the battle MODE for
 * it (the same map hosts different cap layouts across random / ranked /
 * clan / operations).
 *
 * Step 2 offers two kinds of layouts, the honest split:
 *   - MEASURED: exact cap sets learned from the local replay history
 *     (api.getMapCapLayouts — the server's own EntityCreate points, rings
 *     drawn at their true radius over the map preview), with the corpus
 *     dataset filling in modes the local history doesn't already cover
 *     with stronger sample evidence — the res-pack insights rail's FULL
 *     doc when the downloaded pack carries it, else the bundled lite res
 *     doc (src/res/map-insights.json, the replay-corpus CLI's lite
 *     output; both share this envelope shape, the full one adding the
 *     heat grids nothing here reads);
 *   - TEMPLATE: the hand-made presets, clearly labelled as uncalibrated.
 * Emits the confirmed choice; the page owns what happens next (session
 * update, cap instantiation).
 */
import { computed, defineComponent, onMounted, ref, watch, type PropType } from "vue";
import { HkModal, HkStepFlow, HkTabs, HkTag } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { displayMapName } from "@/utils/mapNames";
import { legacyMapOf, mapLineage } from "@/utils/legacyMaps";
import { api, type LearnedCapLayout } from "@/api";
import { loadMapInsights, type MapInsightsDoc } from "../insightsLoader";
import { resolveMapMinimapUrl, type MapBounds } from "../modelLoader";
import { MODE_PRESETS, modePresetOf } from "./modes";
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

/** The confirmed step-2 choice: a measured layout or a template preset. */
export type MapSetupChoice =
  | { kind: "learned"; layout: LearnedCapLayout }
  | { kind: "preset"; presetId: string };

/** One row of step 2's measured section: a layout learned from a local
 *  replay, or one aggregated by the corpus — the corpus row rides the
 *  exact LearnedCapLayout shape so picking/applying it is the very same
 *  path as a local row (world caps, scenario unset). */
type MeasuredEntry =
  | { kind: "local"; layout: LearnedCapLayout }
  | {
      kind: "corpus";
      layout: LearnedCapLayout;
      /** All corpus battles of the (map, mode). */
      battleCount: number;
      /** Battles whose cap observations voted for this layout. */
      capsSample: number;
    };

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
    /** World bounds lookup (the page's loaded minimaps.json) — draws the
     *  preview's cap rings at their TRUE size. Absent = schematic dots. */
    getBounds: {
      type: Function as PropType<(spaceId: string) => MapBounds | null>,
      default: undefined,
    },
    /** Replay dir the measured-layout scan reads (undefined = let the
     *  backend resolve the active install's replays). */
    replaysDir: { type: String, default: undefined },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    confirm: (_spaceId: string, _choice: MapSetupChoice) => true,
  },
  setup(props, { emit }) {
    const { dataLanguage } = useLanguage();
    const step = ref<"map" | "mode">("map");
    const category = ref<CategoryKey>("all");
    const mapId = ref<string | null>(props.currentMapId);
    const modeId = ref<string | null>(props.currentModeId);
    /** The selected measured layout (cleared when a preset is picked). */
    const learnedPick = ref<LearnedCapLayout | null>(null);

    // ── Corpus dataset (res-pack insights rail, bundled lite fallback) ──
    // Empty until the loader resolves — an empty `maps` yields locals only,
    // exactly the untouched-placeholder behavior. A miss of every kind
    // (pack unwired yet, pack without the insights tree, bad shape) lands
    // on the bundled lite doc; the ref only swaps in what the loader
    // actually resolved.
    const mapInsights = ref<MapInsightsDoc>({
      version: 0,
      generatedAt: null,
      unparsed: 0,
      maps: {},
    });
    onMounted(() => {
      void loadMapInsights()
        .then((doc) => {
          mapInsights.value = doc;
        })
        .catch(() => {
          // Keep the empty doc — locals-only measured rows (the bundled
          // import resolves eagerly; this catch is belt-and-braces).
        });
    });

    const steps = computed(() => [
      { key: "map", label: i18nT("tactics.setup.stepMap") },
      { key: "mode", label: i18nT("tactics.setup.stepMode") },
    ]);

    // A fresh wizard pass always starts on the map step with the current
    // selection preloaded — reopening to tweak the mode of the boarded map
    // is one click in, not a re-walk. Selecting a map NEVER auto-advances:
    // the author looks at the preview first and presses 下一步 themselves.
    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          step.value = "map";
          mapId.value = props.currentMapId;
          modeId.value = props.currentModeId;
          learnedPick.value = null;
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

    // ── Measured layouts (learned from the replay history) ──────────────
    const learned = ref<LearnedCapLayout[]>([]);
    const learning = ref(false);
    let learnEpoch = 0;

    watch(
      () => [props.modelValue, step.value, mapId.value] as const,
      ([open, s, id]) => {
        if (!open || s !== "mode" || id == null) return;
        const epoch = ++learnEpoch;
        learning.value = true;
        api
          .getMapCapLayouts(id, props.replaysDir)
          .then((layouts) => {
            if (epoch !== learnEpoch) return;
            learned.value = layouts;
          })
          .catch(() => {
            // no install / unreadable replays — the template presets carry
            // the step alone; measured layouts simply stay empty.
            if (epoch === learnEpoch) learned.value = [];
          })
          .finally(() => {
            if (epoch === learnEpoch) learning.value = false;
          });
      },
    );

    /** The measured section's merged rows: the local learned layouts, with
     *  the corpus dataset filling the gaps. For a mode the local
     *  history already covers, the stronger sample evidence wins — a local
     *  layout counts as the one replay it was learned from, a corpus row
     *  as its capsSample battles — and ties keep the user's own replays.
     *  An empty corpus doc (placeholder / loader miss) yields locals only. */
    const measured = computed<MeasuredEntry[]>(() => {
      const corpus = mapId.value ? mapInsights.value.maps[mapId.value]?.modes : undefined;
      if (!corpus) return learned.value.map((layout) => ({ kind: "local" as const, layout }));
      const localSamples = new Map<string, number>();
      for (const l of learned.value) {
        if (l.modeGroup != null) {
          localSamples.set(l.modeGroup, (localSamples.get(l.modeGroup) ?? 0) + 1);
        }
      }
      const outevidenced = new Set<string>();
      const corpusRows: MeasuredEntry[] = [];
      for (const mode of Object.keys(corpus).sort()) {
        const row = corpus[mode]!;
        if (row.caps.length === 0) continue;
        const local = localSamples.get(mode) ?? 0;
        if (local >= row.capsSample) continue;
        if (local > 0) outevidenced.add(mode);
        corpusRows.push({
          kind: "corpus",
          layout: {
            modeGroup: mode,
            scenario: null,
            sourceReplay: "corpus",
            sourceTime: null,
            caps: row.caps,
          },
          battleCount: row.battleCount,
          capsSample: row.capsSample,
        });
      }
      return [
        ...learned.value
          .filter((l) => l.modeGroup == null || !outevidenced.has(l.modeGroup))
          .map((layout) => ({ kind: "local" as const, layout })),
        ...corpusRows,
      ];
    });

    /** Template presets offered for the chosen map: its observed families
     *  first, then the rest — any map CAN host any mode, the list just
     *  fronts the likely ones. */
    const presetOrder = computed(() => {
      if (!mapId.value) return [...MODE_PRESETS];
      const fam = new Set(props.bucketsOf(mapId.value));
      const score = (m: (typeof MODE_PRESETS)[number]): number => (fam.has(m.family) ? 0 : 1);
      return [...MODE_PRESETS].sort(
        (a, b) => score(a) - score(b) || a.family.localeCompare(b.family),
      );
    });

    const previewUrl = computed(() => (mapId.value ? resolveMapMinimapUrl(mapId.value) : null));

    function chooseMap(id: string): void {
      mapId.value = id;
      // A different map invalidates both step-2 selections.
      learnedPick.value = null;
      modeId.value = null;
    }

    function pickLearned(layout: LearnedCapLayout): void {
      learnedPick.value = layout;
      modeId.value = null;
    }

    function pickPreset(id: string): void {
      modeId.value = id;
      learnedPick.value = null;
    }

    function confirm(): void {
      if (!mapId.value) return;
      if (learnedPick.value) {
        emit("confirm", mapId.value, { kind: "learned", layout: learnedPick.value });
      } else if (modeId.value) {
        emit("confirm", mapId.value, { kind: "preset", presetId: modeId.value });
      } else {
        return;
      }
      emit("update:modelValue", false);
    }

    /** One cap to draw on the preview: percent position + a ring sized by
     *  its true world radius over the playable rect (bounds known), else a
     *  schematic dot. */
    const capDots = computed(() => {
      const preset = modePresetOf(modeId.value);
      const b = mapId.value ? props.getBounds?.(mapId.value) ?? null : null;
      const span = b ? Math.max(b.maxX - b.minX, b.maxZ - b.minZ) : null;
      const fromWorld = (x: number, z: number): { left: string; top: string } => ({
        left: b ? `${((x - b.minX) / (b.maxX - b.minX)) * 100}%` : "50%",
        top: b ? `${((b.maxZ - z) / (b.maxZ - b.minZ)) * 100}%` : "50%",
      });
      const size = (radius: number): string | undefined =>
        span ? `${Math.min(45, ((2 * radius) / span) * 100)}%` : undefined;
      if (learnedPick.value) {
        return learnedPick.value.caps.map((c) => ({
          key: `l${c.index}`,
          letter: String.fromCharCode(65 + Math.max(0, Math.min(25, c.index))),
          ...fromWorld(c.x, c.z),
          size: size(c.radius ?? 115),
          team: null as string | null,
        }));
      }
      if (!preset) return [];
      return preset.caps.map((c, i) => ({
        key: `p${i}`,
        letter: c.letter,
        left: `${c.at.x * 100}%`,
        top: `${(1 - c.at.z) * 100}%`,
        size: size(c.radius),
        team: c.team ?? null,
      }));
    });

    /** Learned-layout card title: the scenario id is the layout's own name
     *  ("domination_3point"); fall back to the match group. */
    function learnedTitle(l: LearnedCapLayout): string {
      return l.scenario ?? l.modeGroup ?? "";
    }

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
          step.value === "map"
            ? {
                label: i18nT("tactics.setup.next"),
                variant: "primary",
                disabled: mapId.value == null,
                onClick: () => (step.value = "mode"),
              }
            : {
                label: i18nT("tactics.setup.confirm"),
                variant: "primary",
                disabled: learnedPick.value == null && modeId.value == null,
                onClick: confirm,
              },
        ]}
      >
        <HkStepFlow
          steps={steps.value}
          modelValue={step.value}
          timelineClickable
          onUpdate:modelValue={(v: string) => {
            // Stepping to "mode" needs a map; going back is always fine.
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
                  <div class="map-setup__section-label">{i18nT("tactics.setup.learnedSection")}</div>
                  {learning.value ? (
                    <p class="map-setup__empty">{i18nT("tactics.setup.learning")}</p>
                  ) : measured.value.length === 0 ? (
                    <p class="map-setup__empty">{i18nT("tactics.setup.noLearned")}</p>
                  ) : (
                    measured.value.map((entry) => {
                      const l = entry.layout;
                      if (entry.kind === "corpus") {
                        return (
                          <button
                            key={`corpus-${learnedTitle(l)}`}
                            type="button"
                            class={[
                              "map-setup__mode",
                              learnedPick.value === l ? "map-setup__mode--on" : "",
                            ]}
                            onClick={() => pickLearned(l)}
                          >
                            <span class="map-setup__mode-head">
                              <strong>{learnedTitle(l)}</strong>
                              <HkTag size="sm" variant="success">
                                {i18nT("tactics.setup.measured")}
                              </HkTag>
                              <HkTag size="sm">{i18nT("tactics.setup.corpusSource")}</HkTag>
                              <HkTag size="sm">
                                {i18nT("tactics.setup.capCount", { n: l.caps.length })}
                              </HkTag>
                              <HkTag size="sm">
                                {i18nT("tactics.setup.sampleCount", { n: entry.capsSample })}
                              </HkTag>
                            </span>
                            <span class="map-setup__mode-desc">
                              {i18nT("tactics.setup.corpusFrom", { n: entry.battleCount })}
                            </span>
                          </button>
                        );
                      }
                      return (
                        <button
                          key={learnedTitle(l) + l.sourceReplay}
                          type="button"
                          class={[
                            "map-setup__mode",
                            learnedPick.value === l ? "map-setup__mode--on" : "",
                          ]}
                          onClick={() => pickLearned(l)}
                        >
                          <span class="map-setup__mode-head">
                            <strong>{learnedTitle(l)}</strong>
                            <HkTag size="sm" variant="success">
                              {i18nT("tactics.setup.measured")}
                            </HkTag>
                            <HkTag size="sm">
                              {i18nT("tactics.setup.capCount", { n: l.caps.length })}
                            </HkTag>
                          </span>
                          <span class="map-setup__mode-desc">
                            {i18nT("tactics.setup.learnedFrom", {
                              date: l.sourceTime ?? l.sourceReplay,
                            })}
                          </span>
                        </button>
                      );
                    })
                  )}
                  <div class="map-setup__section-label">{i18nT("tactics.setup.templateSection")}</div>
                  {presetOrder.value.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      class={[
                        "map-setup__mode",
                        modeId.value === preset.id ? "map-setup__mode--on" : "",
                      ]}
                      onClick={() => pickPreset(preset.id)}
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
                          key={c.key}
                          class={[
                            "map-setup__cap",
                            c.team === "ally"
                              ? "map-setup__cap--ally"
                              : c.team === "enemy"
                                ? "map-setup__cap--enemy"
                                : "",
                            c.size ? "" : "map-setup__cap--dot",
                          ]}
                          style={{
                            left: c.left,
                            top: c.top,
                            ...(c.size ? { width: c.size } : null),
                          }}
                        >
                          {c.letter}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {learnedPick.value ? (
                    <div class="map-setup__meta">
                      <strong>{learnedTitle(learnedPick.value)}</strong>
                      <span>{i18nT("tactics.setup.measured")}</span>
                    </div>
                  ) : modePresetOf(modeId.value) ? (
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
