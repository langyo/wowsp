import { defineComponent, onMounted } from "vue";

import { useReplayParser } from "@/features/replay/useReplayParser";
import HolographicMap from "@/features/holographic/HolographicMap";
import { t } from "@/i18n";
import SButton from "@/components/base/SButton";

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
          <h2>{t("replay.list.title")}</h2>
          {parser.list.value.length === 0 ? (
            <p>{t("replay.list.empty")}</p>
          ) : (
            <ul>
              {parser.list.value.map((p) => (
                <li key={p}>
                  <SButton size="sm" variant="ghost" onClick={() => parser.open(p)}>
                    {p.split(/[\\/]/).pop()}
                  </SButton>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section class="replay-view__main">
          {parser.loading.value ? (
            <p>{t("replay.loading")}</p>
          ) : parser.error.value ? (
            <p class="replay-view__error">{parser.error.value}</p>
          ) : parser.current.value ? (
            <>
              <header class="replay-view__meta">
                <strong>{parser.current.value.mapName ?? parser.current.value.mapId ?? "?"}</strong>
                <span>{parser.current.value.dateTime ?? ""}</span>
                <span>{parser.current.value.matchGroup ?? ""}</span>
                <span>{parser.current.value.vehicles.length} players</span>
              </header>
              <div class="replay-view__map">
                <HolographicMap replayPath={parser.current.value.path} />
              </div>
            </>
          ) : (
            <p>{t("replay.select")}</p>
          )}
        </section>
      </main>
    );
  },
});
