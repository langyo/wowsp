/**
 * Tactics-analysis page (/tactics): a two-pane explorer over the app's
 * bundled BATTLE map catalog. The rail lists the analysable spaces — catalog
 * entries that are battle maps (`battleMapIds`: not a harbor) AND carry
 * bundled minimap art (`resolveMapMinimapUrl`, the same resource pool the
 * replay-review map canvas paints). A map without a minimap cannot be
 * analysed at all, so it is not offered, and the count matches exactly what
 * is listed.
 *
 * Every card carries at least one badge. Mode pills come from the replay
 * history observed on the active install, falling back to the same "random"
 * bucket the mode filter itself assumes for a map with no history yet; the
 * version pills (旧版 / 新版) come from the curated succession table
 * (utils/legacyMaps) that marks a superseded map version and its successor.
 *
 * The right pane is a full tactical PLAN board (TacticalPlanStage): the same
 * toolbar, marker facilities, timeline and export/record paths replay review
 * uses, hosted over the bare map with a fixed 20-minute planning clock and
 * accordion unit tracks that tween a unit between its marked actions.
 * Scenario / special-mode maps (isPveSpace) keep their "incomplete support"
 * warning.
 */
import { computed, defineComponent, onMounted, ref, watch, type DefineComponent } from "vue";

import { HAlert, HTabs } from "@celestia-island/hikari";

import { api } from "@/api";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import { resolveMapMinimapUrl } from "@/features/holographic/modelLoader";
import TacticalPlanStage from "@/features/holographic/tactical/PlanStage";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { MAP_NAMES, displayMapName, replaysDir } from "@/utils/mapNames";
import { battleMapIds, bucketOf, isPveSpace, type MapModeBucket } from "@/utils/mapModes";
import { legacyMapOf, mapLineage } from "@/utils/legacyMaps";
import { modeKey } from "@/utils/modeColors";
import { isMobileApp } from "@/utils/platform";
import "./TacticsView.scss";

/** hikari's HkAlert types `message` as required, but its runtime prefers
 *  the default slot whenever one is given (`slots.default ?
 *  slots.default() : props.message`) — passing both silently drops the
 *  message, and passing a never-rendered string is worse. Retype locally
 *  so the slot-only form needs no dead prop. */
const SlotHAlert = HAlert as unknown as DefineComponent<{
  variant?: "warning" | "error" | "info" | "success";
  size?: "sm" | "md" | "lg";
  title?: string;
}>;

type FilterKey = "all" | "random" | "ranked" | "clan";
const FILTERS: { key: FilterKey; labelKey: string }[] = [
  { key: "all", labelKey: "tactics.filter.all" },
  { key: "random", labelKey: "tactics.filter.random" },
  { key: "ranked", labelKey: "tactics.filter.ranked" },
  { key: "clan", labelKey: "tactics.filter.clan" },
];

/** The rail's map inventory: battle spaces of the bundled catalog whose
 *  minimap art ships with the app — synchronous, no game install required. */
const RAIL_SPACE_IDS = battleMapIds(Object.keys(MAP_NAMES), (id) => resolveMapMinimapUrl(id) !== null);

/** Pill order inside a card's badge row. */
const BUCKET_ORDER: MapModeBucket[] = ["random", "ranked", "clan", "pve"];

export default defineComponent({
  name: "TacticsView",
  setup() {
    // The phone app build has no local game install to inspect, so it renders
    // a static placeholder and mounts none of the loaders/watchers (the nav
    // link is hidden there too — this is belt-and-braces for direct URLs),
    // mirroring LiveView.
    if (isMobileApp()) {
      return () => (
        <main class="tactics-view">
          <div class="tactics-view__placeholder">{t("tactics.list.noClient")}</div>
        </main>
      );
    }

    const gd = useGameDetect();
    const { dataLanguage } = useLanguage();

    const activePath = computed(() => gd.config.activeInstall?.path ?? "");

    /** Per space id: mode buckets actually observed in the local replay
     *  history (see loadHistory). A failed/unreadable history just leaves
     *  maps unclassified — never blocks the map list itself. */
    const observed = ref<Map<string, Set<MapModeBucket>>>(new Map());
    const filter = ref<FilterKey>("all");
    const selected = ref<string | null>(null);

    /** Generation token for loadHistory: switching installs mid-scan lets
     *  the slower previous scan resolve last — without this it would
     *  clobber `observed` with the old install's stale buckets. */
    let historySeq = 0;

    /** Replay-history aggregation: one bucket per battle via
     *  modeKey+bucketOf, keyed by the replay's map (space) name. */
    async function loadHistory() {
      const seq = ++historySeq;
      const acc = new Map<string, Set<MapModeBucket>>();
      if (activePath.value) {
        try {
          const metas = await api.listReplaysMeta(replaysDir(activePath.value));
          for (const m of metas) {
            if (!m.mapName) continue;
            const b = bucketOf(
              modeKey(m.matchGroup, m.scenario, m.eventType, m.botCount ?? 0),
            );
            let set = acc.get(m.mapName);
            if (!set) acc.set(m.mapName, (set = new Set()));
            set.add(b);
          }
        } catch {
          // history is enrichment only — empty buckets are fine
        }
      }
      if (seq !== historySeq) return; // a newer install's scan superseded us
      observed.value = acc;
    }

    onMounted(async () => {
      // Snapshot BEFORE detect(): the watcher below owns the "" → path
      // transition — including the one detect() itself causes — so reading
      // the history here as well would scan the replays dir twice on cold
      // start. Only an install that was already active before the rescan
      // needs an explicit read (the rescan keeps its path, the watcher stays
      // silent). The map list itself needs none of this — it renders from
      // the bundled catalog immediately.
      const wasActive = !!activePath.value;
      await gd.detect();
      if (wasActive) {
        await loadHistory();
      }
    });
    // Follow the sidebar's client switch: the catalog list (and with it the
    // selection) is install-independent; only the replay-history enrichment
    // is re-read for the new install's replays dir.
    watch(activePath, (p, prev) => {
      if (p && p !== prev) {
        void loadHistory();
      }
    });

    /** Buckets a map counts as for the mode filter: observed history plus
     *  the static PVE fingerprint, defaulting to the filter's own "random"
     *  baseline so a map with no history is still reachable. */
    function modeBuckets(spaceId: string): Set<MapModeBucket> {
      const set = new Set<MapModeBucket>();
      if (isPveSpace(spaceId)) set.add("pve");
      const obs = observed.value.get(spaceId);
      if (obs) for (const b of obs) set.add(b);
      if (set.size === 0) set.add("random");
      return set;
    }

    /** "Incomplete support" map: a scenario / special-mode space, or one
     *  whose observed replay history is exclusively PvE. */
    function isIncomplete(spaceId: string): boolean {
      if (isPveSpace(spaceId)) return true;
      const obs = observed.value.get(spaceId);
      if (!obs || obs.size === 0) return false;
      for (const b of obs) if (b !== "pve") return false;
      return true;
    }

    const filtered = computed(() => {
      const f = filter.value;
      return RAIL_SPACE_IDS.filter((id) => f === "all" || modeBuckets(id).has(f));
    });

    /** Selected incomplete map first, then incomplete/PVE maps, then the
     *  rest — within each group by localized display name (space id as the
     *  tie-break) — so picking a PVE map immediately jumps it to position
     *  #1 and the list reads naturally in any UI language. */
    const sorted = computed(() => {
      const lang = dataLanguage.value;
      const sel = selected.value;
      const rank = (id: string) =>
        sel != null && id === sel && isIncomplete(id) ? 0 : isIncomplete(id) ? 1 : 2;
      return [...filtered.value]
        .map((id) => ({ id, name: displayMapName(id, lang) }))
        .sort((a, b) => {
          const r = rank(a.id) - rank(b.id);
          if (r !== 0) return r;
          const byName = a.name.localeCompare(b.name, lang);
          return byName !== 0 ? byName : a.id.localeCompare(b.id);
        })
        .map((e) => e.id);
    });

    /** Badge pills for a complete (PVP) card, in rail order. */
    function badgeBuckets(spaceId: string): MapModeBucket[] {
      const set = modeBuckets(spaceId);
      return BUCKET_ORDER.filter((b) => set.has(b));
    }

    return () => {
      const list = sorted.value;
      const sel = selected.value;
      return (
        <main class="tactics-view">
          <aside class="tactics-view__list">
            <div class="tactics-view__list-head">
              <div class="tactics-view__list-head-row">
                <h2 class="tactics-view__list-title">{t("nav.tactics")}</h2>
                <span class="tactics-view__count">{t("tactics.count", { n: list.length })}</span>
              </div>
              <HTabs
                variant="segmented"
                block
                modelValue={filter.value}
                onUpdate:modelValue={(v: string) => (filter.value = v as FilterKey)}
                tabs={FILTERS.map((f) => ({ key: f.key, label: t(f.labelKey) }))}
              />
            </div>
            <div class="tactics-view__list-scroll">
              {list.length === 0 ? (
                <p class="tactics-view__empty">{t("tactics.list.filterEmpty")}</p>
              ) : (
                <ul class="tactics-view__items">
                  {list.map((id) => {
                    const inc = isIncomplete(id);
                    const lineage = mapLineage(id);
                    const legacy = legacyMapOf(id);
                    return (
                      <li key={id} class="tactics-view__item">
                        <button
                          type="button"
                          class={["tactics-card", sel === id ? "tactics-card--active" : ""]}
                          onClick={() => (selected.value = id)}
                        >
                          <span class="tactics-card__name">{displayMapName(id, dataLanguage.value)}</span>
                          <span class="tactics-card__id">{id}</span>
                          <span class="tactics-card__badges">
                            {inc ? (
                              <span class="tactics-card__badge tactics-card__badge--limited">
                                {t("tactics.badge.limited")}
                              </span>
                            ) : (
                              badgeBuckets(id).map((b) => (
                                <span key={b} class="tactics-card__badge">
                                  {t(`tactics.filter.${b}`)}
                                </span>
                              ))
                            )}
                            {/* Version pills: the superseded map names its
                                successor, the successor is marked as the one
                                a plan should target. */}
                            {lineage === "legacy" ? (
                              <span
                                class="tactics-card__badge tactics-card__badge--legacy"
                                title={
                                  legacy
                                    ? t("tactics.badge.legacyTip", {
                                        name: displayMapName(legacy.replacedBy, dataLanguage.value),
                                      })
                                    : undefined
                                }
                              >
                                {t("tactics.badge.legacy")}
                              </span>
                            ) : null}
                            {lineage === "current" ? (
                              <span class="tactics-card__badge tactics-card__badge--current">
                                {t("tactics.badge.current")}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          <section class="tactics-view__main">
            {!sel ? (
              <div class="tactics-view__placeholder">{t("tactics.select")}</div>
            ) : (
              <div class="tactics-view__detail">
                <header class="tactics-view__detail-head">
                  <strong class="tactics-view__detail-name">
                    {displayMapName(sel, dataLanguage.value)}
                  </strong>
                  <span class="tactics-view__detail-id">{sel}</span>
                  {mapLineage(sel) === "legacy" ? (
                    <span class="tactics-view__detail-note">{t("tactics.badge.legacy")}</span>
                  ) : null}
                </header>
                {/* hikari's HkAlert renders `slots.default ?
                    slots.default() : props.message` — a default slot
                    shadows the message prop, so the body text must live
                    inside the slot itself. */}
                {isIncomplete(sel) ? (
                  <SlotHAlert
                    variant="warning"
                    size="md"
                    title={displayMapName(sel, dataLanguage.value)}
                  >
                    <p class="tactics-view__warning-text">{t("tactics.warning.message")}</p>
                  </SlotHAlert>
                ) : null}
                {/* A fresh board per map: the plan document, viewport, clock
                    and collapsed rows all belong to the selected map. */}
                <TacticalPlanStage
                  key={sel}
                  spaceId={sel}
                  mapName={displayMapName(sel, dataLanguage.value)}
                />
              </div>
            )}
          </section>
        </main>
      );
    };
  },
});
