import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap from "@/features/holographic/HolographicMap";
import { api } from "@/api";
import type { EntityTrajectory, GameInstallKind } from "@/api";
import { t } from "@/i18n";
import SButton from "@/components/base/SButton";
import SSelect, { type SelectOption } from "@/components/base/SSelect";
import SSpinner from "@/components/base/SSpinner";
import type { VehicleEntry } from "@/api";
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
  // Normalize separators and append `replays`.
  const trimmed = installPath.replace(/[\\/]+$/, "");
  return `${trimmed}/replays`;
}

/**
 * Standalone review view (Mode 1). Pick a replay, see its metadata + the
 * holographic map rendering its timeline. Roster is split into allies/enemies
 * using `relation` (0/1 = ally, 2+ = enemy) — the same split the overlay uses.
 *
 * The left rail holds a **client selector** (so multi-install machines — e.g.
 * Steam + Wargaming Center — can switch which client's replays are listed) and
 * the replay list below it. The selector drives `refreshList` with the active
 * install's `replays/` path; without it the list command would fall back to
 * env vars (which are almost never set), yielding an empty list.
 */
export default defineComponent({
  name: "ReplayView",
  setup() {
    const parser = useReplayParser();
    const gd = useGameDetect();

    // Client-selector options derived from detected installs.
    const clientOptions = computed<SelectOption[]>(() =>
      gd.config.installs.map((i) => ({
        value: i.path,
        label: installLabel(i.kind, i.realm),
      })),
    );
    const activePath = computed(() => gd.config.activeInstall?.path ?? "");
    const hasClient = computed(() => gd.config.installs.length > 0);

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
    });

    // When the user picks a different client, update the store + reload.
    async function onSelectClient(path: string) {
      await gd.config.selectInstall(path);
      await reload(path);
    }

    // If the active install changes externally (e.g. a rescan), reload.
    watch(activePath, (p, prev) => {
      if (p && p !== prev) void reload(p);
    });

    const allies = computed<VehicleEntry[]>(
      () => parser.current.value?.vehicles.filter((v) => v.relation <= 1) ?? [],
    );
    const enemies = computed<VehicleEntry[]>(
      () => parser.current.value?.vehicles.filter((v) => v.relation > 1) ?? [],
    );

    // Decoded trajectories for the currently-open replay (M3). Loaded lazily on
    // open so the header parse stays fast; the decode is the expensive step.
    const trajectories = ref<EntityTrajectory[]>([]);
    const trajectoryError = ref<string | null>(null);
    watch(
      () => parser.current.value?.path,
      async (path) => {
        trajectories.value = [];
        trajectoryError.value = null;
        if (!path) return;
        try {
          trajectories.value = await api.readReplayPositions(path);
        } catch (e) {
          trajectoryError.value = (e as Error).message;
        }
      },
    );

    const refreshing = ref(false);
    async function onRefresh() {
      refreshing.value = true;
      try {
        await reload();
      } finally {
        refreshing.value = false;
      }
    }

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
                {parser.list.value.map((p) => (
                  <li key={p} class="replay-view__item">
                    <SButton
                      size="sm"
                      variant="ghost"
                      block
                      onClick={() => parser.open(p)}
                    >
                      {p.split(/[\\/]/).pop()}
                    </SButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section class="replay-view__main">
          {parser.loading.value ? (
            <div class="replay-view__placeholder">
              <SSpinner center size="lg" text={t("replay.loading")} />
            </div>
          ) : parser.error.value ? (
            <div class="replay-view__placeholder replay-view__placeholder--error">
              {parser.error.value}
            </div>
          ) : parser.current.value ? (
            <>
              <header class="replay-view__meta">
                <strong class="replay-view__map">
                  {parser.current.value.mapName ?? `map #${parser.current.value.mapId ?? "?"}`}
                </strong>
                <span class="replay-view__meta-item">
                  {parser.current.value.dateTime ?? ""}
                </span>
                <span class="replay-view__meta-item replay-view__pill">
                  {parser.current.value.matchGroup ?? ""}
                </span>
                <span class="replay-view__meta-item replay-view__count">
                  {parser.current.value.vehicles.length} players
                </span>
              </header>

              <div class="replay-view__body">
                <div class="replay-view__map-wrap">
                  {trajectoryError.value ? (
                    <div class="replay-view__placeholder replay-view__placeholder--error">
                      trajectory decode failed: {trajectoryError.value}
                    </div>
                  ) : (
                    <HolographicMap
                      replayPath={parser.current.value.path}
                      trajectories={trajectories.value}
                      vehicles={parser.current.value.vehicles}
                      mapId={parser.current.value.mapName ?? ""}
                    />
                  )}
                </div>
                <div class="replay-view__roster">
                  <RosterColumn title="Allies" rows={allies.value} kind="ally" />
                  <RosterColumn title="Enemies" rows={enemies.value} kind="enemy" />
                </div>
              </div>
            </>
          ) : (
            <div class="replay-view__placeholder">{t("replay.select")}</div>
          )}
        </section>
      </main>
    );
  },
});

/** A two-column roster (allies | enemies) rendered from a replay's vehicles. */
const RosterColumn = defineComponent({
  name: "RosterColumn",
  props: {
    title: { type: String, required: true },
    rows: { type: Array as () => VehicleEntry[], required: true },
    kind: { type: String as () => "ally" | "enemy", required: true },
  },
  setup(props) {
    return () => (
      <div class={["roster-col", `roster-col--${props.kind}`]}>
        <div class="roster-col__head">
          {props.title} <span class="roster-col__count">{props.rows.length}</span>
        </div>
        <ul class="roster-col__list">
          {props.rows.map((v) => (
            <li class="roster-col__row" key={v.id}>
              <span class="roster-col__name">{v.name || `#${v.id}`}</span>
              <span class="roster-col__ship">
                {v.shipName ?? `ship ${v.shipId}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  },
});
