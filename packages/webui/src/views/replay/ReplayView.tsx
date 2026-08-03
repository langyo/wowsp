import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap from "@/features/holographic/HolographicMap";
import { api } from "@/api";
import type { EntityTrajectory, ExplosionEvent, GameInstallKind, TorpedoLaunch } from "@/api";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { modeColor } from "@/utils/modeColors";
import { useToast } from "@/composables/useToast";
import SButton from "@/components/base/SButton";
import SSelect, { type SelectOption } from "@/components/base/SSelect";
import "./ReplayView.scss";

/** Map a client kind to its localized label (e.g. Steam / 官服 / Lesta / 国服). */
function kindLabel(kind: GameInstallKind | null | undefined): string {
  if (!kind) return "";
  return t(`common.game.kind.${kind}`);
}

/** Build a short label for a client selector option: "Steam · ASIA". */
function installLabel(kind: GameInstallKind, realm?: string | null): string {
  const parts = [kindLabel(kind)];
  if (realm) parts.push(realm.toUpperCase());
  return parts.join(" · ");
}

/** The replays subfolder of a client install. WoWS writes replays under
 *  `<install>/replays/`. */
function replaysDir(installPath: string): string {
  const trimmed = installPath.replace(/[\\/]+$/, "");
  return `${trimmed}/replays`;
}

/** Localize a replay matchGroup ("pvp"/"ranked"/…) with a generic fallback. */
function modeLabel(group?: string | null): string {
  if (!group) return t("replay.mode._fallback");
  const key = `replay.mode.${group}`;
  const lbl = t(key);
  // t() returns the key when missing — fall back to the generic battle label.
  return lbl === key ? t("replay.mode._fallback") : lbl;
}

/** Resolve a map's localized display name from its internal space id (e.g.
 *  "18_NE_ice_islands" → "冰之岛"/"Islands of Ice"). Space ids often DON'T
 *  match the display name (WG renamed maps but kept the internal id — e.g.
 *  "38_Canada" is "Shatter"/"碎裂"), so this lookup is authoritative. Falls
 *  back to the raw id, then to the unknown-map label. */
function displayMapName(spaceId?: string | null): string {
  if (!spaceId) return t("replay.map.unknown");
  const key = `replay.map.names.${spaceId}`;
  const lbl = t(key);
  return lbl === key ? spaceId : lbl;
}

/** Format a `YYYYMMDD[_HHMMSS]` timestamp from the replay filename into a
 *  locale-friendly date(+time) string. Returns "—" if unparseable. */
function formatDateTime(dt?: string | null): string {
  if (!dt) return "—";
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:_(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return dt;
  const [, y, mo, d, hh, mm] = m;
  const hhmm = hh ? ` ${hh}:${mm}` : "";
  return `${y}-${mo}-${d}${hhmm}`;
}

/**
 * Standalone review view (Mode 1). The left rail lists replays as info cards
 * indexed by match time / mode / own ship / map; picking one opens the detail
 * view: a holographic battle map, the recorder's ship as a holographic model,
 * and an enriched roster (this-match ship + ship type + on-demand avg stats).
 */
export default defineComponent({
  name: "ReplayView",
  setup() {
    const parser = useReplayParser();
    const gd = useGameDetect();
    const accounts = useAccountStore();
    const encyclopedia = useEncyclopediaStore();
    const toast = useToast();

    // Auto-manage loading toast for replay operations.
    let loadingToastId = 0;
    watch(() => parser.loading.value, (v) => {
      if (v) {
        loadingToastId = toast.loading(t("replay.loading"));
      } else if (loadingToastId) {
        toast.dismiss(loadingToastId);
        loadingToastId = 0;
      }
    });

    // Client-selector options derived from detected installs.
    const clientOptions = computed<SelectOption[]>(() =>
      gd.config.installs.map((i) => ({
        value: i.path,
        label: installLabel(i.kind, i.realm),
      })),
    );
    const activePath = computed(() => gd.config.activeInstall?.path ?? "");
    const hasClient = computed(() => gd.config.installs.length > 0);

    /** The realm to query player stats against. Prefer the client install's
     *  realm, then the bound account's realm, else the UI default. */
    const realm = computed(
      () =>
        gd.config.activeInstall?.realm ??
        accounts.activeAccount?.realm ??
        accounts.activeRealm ??
        "asia",
    );

    /** Reload the replay list from the given (or active) client's replays dir. */
    async function reload(path?: string) {
      const dir = path ? replaysDir(path) : activePath.value ? replaysDir(activePath.value) : undefined;
      try {
        await parser.refreshList(dir);
      } catch {
        // surfaced via store.error; list stays empty
      }
    }

    onMounted(async () => {
      await gd.detect();
      await reload();
      void encyclopedia.load(realm.value).catch(() => {});
    });

    async function onSelectClient(path: string) {
      await gd.config.selectInstall(path);
      await reload(path);
    }

    watch(activePath, (p, prev) => {
      if (p && p !== prev) void reload(p);
    });

    // Decoded trajectories for the currently-open replay (M3). Loaded lazily on
    // open so the header parse stays fast; the decode is the expensive step.
    const trajectories = ref<EntityTrajectory[]>([]);
    const explosions = ref<ExplosionEvent[]>([]);
    const torpedoes = ref<TorpedoLaunch[]>([]);
    const trajectoryError = ref<string | null>(null);
    /** Match duration (seconds) — the max sample time across all trajectories.
     *  Only knowable after the packet stream is decoded; shown in the detail. */
    const duration = ref(0);
    watch(
      () => parser.current.value?.path,
      async (path) => {
        trajectories.value = [];
        explosions.value = [];
        torpedoes.value = [];
        trajectoryError.value = null;
        duration.value = 0;
        if (!path) return;
        try {
          const stream = await api.readReplayPositions(path);
          trajectories.value = stream.trajectories;
          explosions.value = stream.explosions ?? [];
          torpedoes.value = stream.torpedoes ?? [];
          let maxT = 0;
          for (const tr of stream.trajectories) {
            for (const s of tr.samples) if (s.time > maxT) maxT = s.time;
          }
          duration.value = maxT;
        } catch (e) {
          trajectoryError.value = (e as Error).message;
        }
      },
    );

    /** Format a match duration (seconds) as M:SS or H:MM:SS. */
    function formatDuration(sec: number): string {
      if (!sec || sec <= 0) return "—";
      const s = Math.round(sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      const pad = (n: number) => String(n).padStart(2, "0");
      return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
    }

    const refreshing = ref(false);
    async function onRefresh() {
      refreshing.value = true;
      try {
        await reload();
      } finally {
        refreshing.value = false;
      }
    }

    const currentPath = computed(() => parser.current.value?.path ?? "");

    return () => (
      <main class="replay-view">
        <aside class="replay-view__list">
          <div class="replay-view__list-head">
            <div class="replay-view__list-head-row">
              <h2 class="replay-view__list-title">{t("replay.list.title")}</h2>
              <SButton
                size="sm"
                variant="ghost"
                disabled={!hasClient.value || refreshing.value}
                onClick={() => void onRefresh()}
                title={t("replay.refresh")}
              >
                <RefreshCw size={14} class={refreshing.value ? "replay-view__spin" : ""} />
              </SButton>
            </div>

            {hasClient.value ? (
              <SSelect
                size="sm"
                block
                modelValue={activePath.value}
                onUpdate:modelValue={(v: string) => void onSelectClient(v)}
                options={clientOptions.value}
                placeholder={t("replay.client")}
              />
            ) : (
              <p class="replay-view__no-client">{t("replay.list.noClient")}</p>
            )}

            {parser.list.value.length > 0 ? (
              <span class="replay-view__count">
                {t("replay.list.count", { n: parser.list.value.length })}
              </span>
            ) : null}
          </div>

          <div class="replay-view__list-scroll">
            {!hasClient.value ? (
              <p class="replay-view__empty">{t("replay.list.noClient")}</p>
            ) : parser.list.value.length === 0 ? (
              <p class="replay-view__empty">{t("replay.list.empty")}</p>
            ) : (
              <ul class="replay-view__items">
                {parser.list.value.map((r) => (
                  <li key={r.path} class="replay-view__item">
                    <button
                      type="button"
                      class={[
                        "replay-card",
                        currentPath.value === r.path ? "replay-card--active" : "",
                      ]}
                      onClick={() => parser.open(r.path)}
                    >
                      <div class="replay-card__top">
                        <span class="replay-card__ship">
                          {r.ownShipName ?? t("replay.ownShip")}
                        </span>
                        {r.matchGroup ? (
                          <span class="replay-card__pill" style={modeColor(r.matchGroup)}>
                            {modeLabel(r.matchGroup)}
                          </span>
                        ) : null}
                      </div>
                      <div class="replay-card__row">
                        <span class="replay-card__label">{t("replay.matchTime")}</span>
                        <span class="replay-card__val">{formatDateTime(r.dateTime)}</span>
                      </div>
                      <div class="replay-card__row">
                        <span class="replay-card__label">{t("replay.mapLabel")}</span>
                        <span class="replay-card__val">{displayMapName(r.mapName)}</span>
                      </div>
                      <div class="replay-card__foot">
                        <span class="replay-card__players">
                          {t("replay.players", { n: r.playerCount })}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section class="replay-view__main">
          {parser.current.value ? (
            <div class="replay-view__content">
              {parser.error.value ? (
                <div class="replay-view__placeholder replay-view__placeholder--error">
                  {parser.error.value}
                </div>
              ) : null}
              <header class="replay-view__meta">
                <strong class="replay-view__map">
                  {displayMapName(parser.current.value.mapName)}
                </strong>
                <span class="replay-view__meta-item">
                  {formatDateTime(parser.current.value.dateTime)}
                </span>
                {parser.current.value.matchGroup ? (
                  <span
                    class="replay-view__meta-item replay-view__pill"
                    style={modeColor(parser.current.value.matchGroup)}
                  >
                    {modeLabel(parser.current.value.matchGroup)}
                  </span>
                ) : null}
                <span class="replay-view__meta-item replay-view__count">
                  {t("replay.players", { n: parser.current.value.vehicles.length })}
                </span>
                {duration.value > 0 ? (
                  <span class="replay-view__meta-item">
                    {t("replay.duration")}: <strong>{formatDuration(duration.value)}</strong>
                  </span>
                ) : null}
              </header>

              <div class="replay-view__detail">
                <div class="replay-view__map-wrap">
                  {trajectoryError.value ? (
                    <div class="replay-view__placeholder replay-view__placeholder--error">
                      trajectory decode failed: {trajectoryError.value}
                    </div>
                  ) : (
                    <HolographicMap
                      replayPath={parser.current.value.path}
                      trajectories={trajectories.value}
                      explosions={explosions.value}
                      torpedoes={torpedoes.value}
                      vehicles={parser.current.value.vehicles}
                      encyclopedia={encyclopedia.byId.value}
                      mapId={parser.current.value.mapName ?? ""}
                      matchGroup={parser.current.value.matchGroup ?? ""}
                      mapName={parser.current.value.mapName ?? ""}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : parser.error.value ? (
            <div class="replay-view__placeholder replay-view__placeholder--error">
              {parser.error.value}
            </div>
          ) : (
            <div class="replay-view__placeholder">{t("replay.select")}</div>
          )}
        </section>
      </main>
    );
  },
});
