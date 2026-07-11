import { computed, defineComponent, onMounted } from "vue";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap from "@/features/holographic/HolographicMap";
import { t } from "@/i18n";
import SButton from "@/components/base/SButton";
import type { VehicleEntry } from "@/api";
import "./ReplayView.scss";

/**
 * Standalone review view (Mode 1). Pick a replay, see its metadata + the
 * holographic map rendering its timeline. Roster is split into allies/enemies
 * using `relation` (0/1 = ally, 2+ = enemy) — the same split the overlay uses.
 */
export default defineComponent({
  name: "ReplayView",
  setup() {
    const parser = useReplayParser();
    const gd = useGameDetect();
    onMounted(() => {
      void gd.detect();
      void parser.refreshList();
    });

    const allies = computed<VehicleEntry[]>(
      () => parser.current.value?.vehicles.filter((v) => v.relation <= 1) ?? [],
    );
    const enemies = computed<VehicleEntry[]>(
      () => parser.current.value?.vehicles.filter((v) => v.relation > 1) ?? [],
    );

    return () => (
      <main class="replay-view">
        <aside class="replay-view__list">
          <h2 class="replay-view__list-title">{t("replay.list.title")}</h2>
          {gd.active.value ? (
            <p class="replay-view__game-path" title={gd.active.value.path}>
              {gd.active.value.path.split(/[\\/]/).pop()}
              {gd.active.value.realm ? ` · ${gd.active.value.realm}` : null}
            </p>
          ) : null}
          {parser.list.value.length === 0 ? (
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
        </aside>

        <section class="replay-view__main">
          {parser.loading.value ? (
            <div class="replay-view__placeholder">{t("replay.loading")}</div>
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
                  <HolographicMap replayPath={parser.current.value.path} />
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
