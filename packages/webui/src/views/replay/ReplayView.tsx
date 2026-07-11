import { defineComponent, onMounted } from "vue";

import { useReplayParser } from "@/features/replay/useReplayParser";
import HolographicMap from "@/features/holographic/HolographicMap";
import { t } from "@/i18n";
import SButton from "@/components/base/SButton";
import "./ReplayView.scss";

/**
 * Standalone review view (Mode 1). Pick a replay, see its metadata + the
 * holographic map rendering its timeline.
 */
export default defineComponent({
  name: "ReplayView",
  setup() {
    const parser = useReplayParser();
    onMounted(() => void parser.refreshList());

    return () => (
      <main class="replay-view">
        <aside class="replay-view__list">
          <h2 class="replay-view__list-title">{t("replay.list.title")}</h2>
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
                  {parser.current.value.mapName ?? parser.current.value.mapId ?? "?"}
                </strong>
                <span class="replay-view__meta-item">{parser.current.value.dateTime ?? ""}</span>
                <span class="replay-view__meta-item">{parser.current.value.matchGroup ?? ""}</span>
                <span class="replay-view__meta-item replay-view__count">
                  {parser.current.value.vehicles.length} players
                </span>
              </header>
              <div class="replay-view__map-wrap">
                <HolographicMap replayPath={parser.current.value.path} />
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
