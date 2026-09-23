/**
 * Tactics-analysis page (/tactics): a two-pane explorer over every playable
 * map in the active game install. The rail lists the install's map
 * inventory (`list_game_maps`) with a coarse mode filter (all / random /
 * ranked / clan); the right pane previews the map's bundled minimap art.
 *
 * Scenario / special-mode maps (isPveSpace) — and maps whose replay history
 * is exclusively PvE — have incomplete support: selecting one shows a
 * warning with the map's modification time and backing .pkg path instead of
 * pretending full analysis exists. Replay history is optional enrichment:
 * bucket classification degrades gracefully when it can't be read.
 */
import { computed, defineComponent, onMounted, ref, watch, type DefineComponent } from "vue";

import { HAlert, HSpinner, HTabs } from "@celestia-island/hikari";

import { api, type GameMapEntry } from "@/api";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import { resolveMapMinimapUrl } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { displayMapName, replaysDir } from "@/utils/mapNames";
import { bucketOf, isPveSpace, type MapModeBucket } from "@/utils/mapModes";
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

/** ms epoch → "YYYY-MM-DD HH:mm" (local time); "—" when unknown. */
function formatMtime(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
    const hasClient = computed(() => gd.config.installs.length > 0);

    const maps = ref<GameMapEntry[]>([]);
    const loading = ref(false);
    const failed = ref(false);
    /** Per space id: mode buckets actually observed in the local replay
     *  history (see loadHistory). A failed/unreadable history just leaves
     *  maps unclassified — never blocks the map list itself. */
    const observed = ref<Map<string, Set<MapModeBucket>>>(new Map());
    const filter = ref<FilterKey>("all");
    const selected = ref<GameMapEntry | null>(null);

    /** Replay-history aggregation: one bucket per battle via
     *  modeKey+bucketOf, keyed by the replay's map (space) name. */
    async function loadHistory() {
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
      observed.value = acc;
    }

    async function loadMaps() {
      loading.value = true;
      failed.value = false;
      try {
        maps.value = await api.listGameMaps(activePath.value);
        await loadHistory();
      } catch {
        maps.value = [];
        failed.value = true;
      } finally {
        loading.value = false;
      }
    }

    onMounted(async () => {
      // Snapshot BEFORE detect(): the watcher below owns the "" → path
      // transition — including the one detect() itself causes — so loading
      // here as well would mount the expensive Rust VFS twice on cold start.
      // Only an install that was already active before the rescan needs an
      // explicit load (the rescan keeps its path, the watcher stays silent).
      const wasActive = !!activePath.value;
      await gd.detect();
      if (wasActive) {
        await loadMaps();
      }
    });
    // Follow the sidebar's client switch: reload the new install's inventory
    // (the previous selection belonged to the old install's list).
    watch(activePath, (p, prev) => {
      if (p && p !== prev) {
        selected.value = null;
        void loadMaps();
      }
    });

    /** Static + observed buckets for a space. A non-PVE space with no
     *  observed history defaults to "random" (the bucketOf fallback
     *  family) so the mode filters stay usable on a fresh install. */
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
      return maps.value.filter((m) => f === "all" || modeBuckets(m.spaceId).has(f));
    });

    /** Selected incomplete map first, then incomplete/PVE maps by mtime
     *  desc (nulls last), then the rest by mtime desc — so picking a PVE
     *  map immediately jumps it to position #1. */
    const sorted = computed(() => {
      const sel = selected.value;
      const rank = (m: GameMapEntry) =>
        sel != null && m.spaceId === sel.spaceId && isIncomplete(m.spaceId)
          ? 0
          : isIncomplete(m.spaceId)
            ? 1
            : 2;
      return [...filtered.value].sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        if (a.mtimeMs == null && b.mtimeMs == null) {
          return a.spaceId.localeCompare(b.spaceId);
        }
        if (a.mtimeMs == null) return 1;
        if (b.mtimeMs == null) return -1;
        return b.mtimeMs - a.mtimeMs;
      });
    });

    /** Small pills for a complete (PVP) card: the observed buckets that
     *  carry a filter label — skipped entirely when history observed none. */
    function observedPvpBuckets(spaceId: string): MapModeBucket[] {
      const obs = observed.value.get(spaceId);
      if (!obs) return [];
      return [...obs].filter((b) => b !== "pve");
    }

    const artUrl = computed(() =>
      selected.value ? resolveMapMinimapUrl(selected.value.spaceId) : null,
    );

    return () => {
      const list = sorted.value;
      const sel = selected.value;
      return (
        <main class="tactics-view">
          <aside class="tactics-view__list">
            <div class="tactics-view__list-head">
              <div class="tactics-view__list-head-row">
                <h2 class="tactics-view__list-title">{t("nav.tactics")}</h2>
                {!loading.value && !failed.value && maps.value.length > 0 ? (
                  <span class="tactics-view__count">{t("tactics.count", { n: list.length })}</span>
                ) : null}
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
              {loading.value ? (
                <div class="tactics-view__state">
                  <HSpinner size="md" tone="current" />
                  <p>{t("tactics.loading")}</p>
                </div>
              ) : !hasClient.value ? (
                <p class="tactics-view__empty">{t("tactics.list.noClient")}</p>
              ) : failed.value ? (
                <p class="tactics-view__empty">{t("tactics.list.error")}</p>
              ) : list.length === 0 ? (
                <p class="tactics-view__empty">{t("tactics.list.empty")}</p>
              ) : (
                <ul class="tactics-view__items">
                  {list.map((m) => {
                    const inc = isIncomplete(m.spaceId);
                    return (
                      <li key={m.spaceId} class="tactics-view__item">
                        <button
                          type="button"
                          class={[
                            "tactics-card",
                            sel && sel.spaceId === m.spaceId
                              ? "tactics-card--active"
                              : "",
                          ]}
                          onClick={() => (selected.value = m)}
                        >
                          <span class="tactics-card__name">
                            {displayMapName(m.spaceId, dataLanguage.value)}
                          </span>
                          <span class="tactics-card__id">{m.spaceId}</span>
                          <span class="tactics-card__badges">
                            {inc ? (
                              <span class="tactics-card__badge tactics-card__badge--limited">
                                {t("tactics.badge.limited")}
                              </span>
                            ) : (
                              observedPvpBuckets(m.spaceId).map((b) => (
                                <span key={b} class="tactics-card__badge">
                                  {t(`tactics.filter.${b}`)}
                                </span>
                              ))
                            )}
                          </span>
                          {inc ? (
                            <>
                              <div class="tactics-card__row">
                                <span class="tactics-card__label">
                                  {t("tactics.warning.modified")}
                                </span>
                                <span class="tactics-card__val">{formatMtime(m.mtimeMs)}</span>
                              </div>
                              <div class="tactics-card__row">
                                <span class="tactics-card__label">
                                  {t("tactics.warning.path")}
                                </span>
                                <span class="tactics-card__val" title={m.pkgPath}>
                                  {m.pkgPath}
                                </span>
                              </div>
                            </>
                          ) : null}
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
                    {displayMapName(sel.spaceId, dataLanguage.value)}
                  </strong>
                  <span class="tactics-view__detail-id">{sel.spaceId}</span>
                </header>
                {/* hikari's HkAlert renders `slots.default ?
                    slots.default() : props.message` — a default slot
                    shadows the message prop, so the body text must live
                    inside the slot itself. */}
                {isIncomplete(sel.spaceId) ? (
                  <SlotHAlert
                    variant="warning"
                    size="md"
                    title={displayMapName(sel.spaceId, dataLanguage.value)}
                  >
                    <p class="tactics-view__warning-text">
                      {t("tactics.warning.message")}
                    </p>
                    <div class="tactics-view__detail-rows">
                      <div class="tactics-view__detail-row">
                        <span class="tactics-view__detail-label">
                          {t("tactics.warning.modified")}
                        </span>
                        <span class="tactics-view__detail-val">
                          {formatMtime(sel.mtimeMs)}
                        </span>
                      </div>
                      <div class="tactics-view__detail-row">
                        <span class="tactics-view__detail-label">
                          {t("tactics.warning.path")}
                        </span>
                        <span class="tactics-view__detail-val" title={sel.pkgPath}>
                          {sel.pkgPath}
                        </span>
                      </div>
                    </div>
                  </SlotHAlert>
                ) : null}
                <div class="tactics-view__art">
                  {artUrl.value ? (
                    <img
                      class="tactics-view__art-img"
                      src={artUrl.value}
                      alt={displayMapName(sel.spaceId, dataLanguage.value)}
                    />
                  ) : (
                    <div class="tactics-view__no-art">{t("tactics.noArt")}</div>
                  )}
                </div>
              </div>
            )}
          </section>
        </main>
      );
    };
  },
});
