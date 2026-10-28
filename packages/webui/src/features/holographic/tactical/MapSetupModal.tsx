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
 *     doc (src/data/map-insights.json, the replay-corpus CLI's lite
 *     output; both share this envelope shape, the full one adding the
 *     heat grids nothing here reads);
 *   - CUSTOM: one entry opening the second-level editor, where the author
 *     edits points by hand (the hand-made templates live INSIDE that
 *     editor as starting points, and any replay file can be imported for
 *     exact point matching — a Neptune-series practice recording, say).
 * Emits the confirmed choice; the page owns what happens next (session
 * update, cap instantiation).
 */
import { computed, defineComponent, onMounted, ref, watch, type PropType } from "vue";
import { HkModal, HkScrollContainer, HkStepFlow, HkTabs, HkTag } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { displayMapName } from "@/utils/mapNames";
import { legacyMapOf, mapLineage } from "@/utils/legacyMaps";
import { api, type LearnedCapLayout } from "@/api";
import { loadMapInsights, type MapInsightsDoc } from "../insightsLoader";
import { noteMapMinimapLoadError, resolveMapMinimapUrl, type MapBounds } from "../modelLoader";
import CapEditorModal from "./CapEditorModal";
import ReplaySourcesTip from "./ReplaySourcesTip";
import type { CapSpec } from "./modes";
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

/** The confirmed step-2 choice: a measured layout, or a custom layout
 *  authored in the second-level editor (which itself may have started from
 *  a template or an imported replay). */
export type MapSetupChoice =
  | { kind: "learned"; layout: LearnedCapLayout }
  | { kind: "custom"; caps: CapSpec[] };

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
    /** The selected measured layout (cleared when the custom editor runs). */
    const learnedPick = ref<LearnedCapLayout | null>(null);
    /** Custom layout confirmed by the second-level editor. */
    const customCaps = ref<CapSpec[] | null>(null);
    const editorOpen = ref(false);

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
          learnedPick.value = null;
          customCaps.value = null;
          editorOpen.value = false;
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

    const previewUrl = computed(() => (mapId.value ? resolveMapMinimapUrl(mapId.value) : null));

    function chooseMap(id: string): void {
      mapId.value = id;
      // A different map invalidates both step-2 selections.
      learnedPick.value = null;
      customCaps.value = null;
    }

    function pickLearned(layout: LearnedCapLayout): void {
      learnedPick.value = layout;
      customCaps.value = null;
    }

    function confirm(): void {
      if (!mapId.value) return;
      if (learnedPick.value) {
        emit("confirm", mapId.value, { kind: "learned", layout: learnedPick.value });
      } else if (customCaps.value) {
        emit("confirm", mapId.value, { kind: "custom", caps: customCaps.value });
      } else {
        return;
      }
      emit("update:modelValue", false);
    }

    /** One cap to draw on the preview: percent position + a ring sized by
     *  its true world radius over the playable rect (bounds known), else a
     *  schematic dot. */
    const capDots = computed(() => {
      const b = mapId.value ? props.getBounds?.(mapId.value) ?? null : null;
      const span = b ? Math.max(b.maxX - b.minX, b.maxZ - b.minZ) : null;
      const fromWorld = (x: number, z: number): { left: string; top: string } => ({
        left: b ? `${((x - b.minX) / (b.maxX - b.minX)) * 100}%` : "50%",
        top: b ? `${((b.maxZ - z) / (b.maxZ - b.minZ)) * 100}%` : "50%",
      });
      const size = (radius: number): string | undefined =>
        span ? `${Math.min(45, ((2 * radius) / span) * 100)}%` : undefined;
      const source = learnedPick.value
        ? learnedPick.value.caps.map((c, i) => ({
            key: `l${i}`,
            letter: String.fromCharCode(65 + Math.max(0, Math.min(25, c.index))),
            x: c.x,
            z: c.z,
            radius: c.radius ?? 115,
            team: learnedTeamOf(c, learnedPick.value?.recorderTeam) as string | null,
          }))
        : customCaps.value
          ? customCaps.value.map((c, i) => ({
              key: `c${i}`,
              letter: c.letter,
              x: c.at.x,
              z: c.at.z,
              radius: c.radius,
              team: c.team ?? null,
            }))
          : [];
      return source.map((c) => ({
        key: c.key,
        letter: c.letter,
        ...fromWorld(c.x, c.z),
        size: size(c.radius),
        team: c.team,
      }));
    });

    /** Learned-layout card title: the scenario id is the layout's own name
     *  ("domination_3point"); fall back to the match group. */
    function learnedTitle(l: LearnedCapLayout): string {
      return l.scenario ?? l.modeGroup ?? "";
    }

    /** Team of one learned cap relative to the recorder ("ally" when the
     *  recorder's side owns it, "enemy" for the other team, null neutral /
     *  unanchored). */
    function learnedTeamOf(
      cap: { team?: number | null },
      recorderTeam: number | null | undefined,
    ): "ally" | "enemy" | null {
      if (cap.team == null || recorderTeam == null || recorderTeam === undefined) return null;
      if (cap.team === recorderTeam) return "ally";
      if (cap.team === 0 || cap.team === 1) return "enemy";
      return null;
    }

    /** Pre-own split of a cap set for the card's info line: counts per
     *  side; null when the side cannot be named (no recorder anchor or no
     *  pre-owned cap at all — the line then degrades to the point count). */
    function preownedOf(
      caps: Array<{ team?: number | null }>,
      recorderTeam?: number | null,
    ): { ally: number; enemy: number } | null {
      if (recorderTeam == null) return null;
      let ally = 0;
      let enemy = 0;
      for (const c of caps) {
        const t = learnedTeamOf(c, recorderTeam);
        if (t === "ally") ally += 1;
        else if (t === "enemy") enemy += 1;
      }
      return ally + enemy > 0 ? { ally, enemy } : null;
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
                disabled: learnedPick.value == null && customCaps.value == null,
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
                  {/* Scroll region: hikari's HkScrollContainer owns the
                      scrollbar (auto-hiding overlay track); the map rows
                      scroll inside its viewport. */}
                  <HkScrollContainer class="map-setup__list">
                    <div class="map-setup__list-inner">
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
                  </HkScrollContainer>
                </div>
                <div class="map-setup__preview">
                  {previewUrl.value ? (
                    <img
                      class="map-setup__art"
                      src={previewUrl.value}
                      alt=""
                      draggable={false}
                      onError={noteMapMinimapLoadError}
                    />
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
                {/* Scroll region: hikari's HkScrollContainer owns the
                    scrollbar (auto-hiding overlay track); the mode cards
                    scroll inside its viewport. */}
                <HkScrollContainer class="map-setup__modes">
                  <div class="map-setup__modes-inner">
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
                              {i18nT("tactics.setup.capsOnly", { n: l.caps.length })}
                              · {i18nT("tactics.setup.corpusFrom", { n: entry.battleCount })}
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
                          </span>
                          <span class="map-setup__mode-desc">
                            {(() => {
                              const pre = preownedOf(l.caps, l.recorderTeam);
                              return pre
                                ? i18nT("tactics.setup.capsPreowned", {
                                    n: l.caps.length,
                                    ally: pre.ally,
                                    enemy: pre.enemy,
                                  })
                                : i18nT("tactics.setup.capsOnly", { n: l.caps.length });
                            })()}
                          </span>
                          {(() => {
                            // Provenance chip: the repeat count, with the
                            // full (scrollable) file list on hover — a
                            // single replay lists itself the same way.
                            const files = l.replays ?? [];
                            if (files.length === 0) return null;
                            return (
                              <ReplaySourcesTip
                                label={i18nT("tactics.setup.replaySources", { n: files.length })}
                                replays={files}
                              />
                            );
                          })()}
                        </button>
                      );
                    })
                  )}
                  <div class="map-setup__section-label">{i18nT("tactics.cap.section")}</div>
                  <button
                    type="button"
                    class={["map-setup__mode", customCaps.value ? "map-setup__mode--on" : ""]}
                    onClick={() => {
                      learnedPick.value = null;
                      editorOpen.value = true;
                    }}
                  >
                    <span class="map-setup__mode-head">
                      <strong>{i18nT("tactics.setup.custom")}</strong>
                      {customCaps.value ? (
                        <HkTag size="sm">
                          {i18nT("tactics.setup.capCount", { n: customCaps.value.length })}
                        </HkTag>
                      ) : null}
                    </span>
                    <span class="map-setup__mode-desc">{i18nT("tactics.setup.customDesc")}</span>
                  </button>
                  </div>
                </HkScrollContainer>
                <div class="map-setup__preview">
                  {previewUrl.value ? (
                    <div class="map-setup__art-wrap">
                      <img
                        class="map-setup__art"
                        src={previewUrl.value}
                        alt=""
                        draggable={false}
                        onError={noteMapMinimapLoadError}
                      />
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
                  ) : customCaps.value ? (
                    <div class="map-setup__meta">
                      <strong>{i18nT("tactics.setup.custom")}</strong>
                      <span>{i18nT("tactics.setup.capCount", { n: customCaps.value.length })}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ),
          }}
        />
        {/* The custom editor runs as a second-level window over the wizard:
            templates and replay import live INSIDE it, not in step 2. */}
        {mapId.value ? (
          <CapEditorModal
            modelValue={editorOpen.value}
            onUpdate:modelValue={(v: boolean) => (editorOpen.value = v)}
            spaceId={mapId.value}
            initialCaps={
              customCaps.value ??
              (learnedPick.value
                ? learnedPick.value.caps.map((c) => ({
                    letter: String.fromCharCode(65 + Math.max(0, Math.min(25, c.index))),
                    at: { x: c.x, z: c.z },
                    radius: c.radius ?? 115,
                    team: learnedTeamOf(c, learnedPick.value?.recorderTeam),
                  }))
                : [])
            }
            getBounds={props.getBounds}
            onApply={(caps: CapSpec[]) => {
              customCaps.value = caps;
              learnedPick.value = null;
            }}
          />
        ) : null}
      </HkModal>
    );
  },
});
