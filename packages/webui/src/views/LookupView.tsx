import { defineComponent, ref } from "vue";

import StatsCard from "@/components/stats/StatsCard";
import SButton from "@/components/base/SButton";
import { useStatsStore } from "@/stores/stats";
import type { PlayerStats } from "@/api";
import { t } from "@/i18n";
import "./LookupView.scss";

/**
 * Stats lookup page. Search box (nickname + realm) → WG API query → deep
 * stats card display. Uses the stats store, which appends a snapshot on each
 * lookup (so repeated lookups build trend history).
 */
export default defineComponent({
  name: "LookupView",
  setup() {
    const stats = useStatsStore();
    const nickname = ref("");
    const realm = ref("asia");
    const realms = ["ru", "eu", "na", "asia"];
    const result = ref<PlayerStats | null>(null);

    async function search() {
      const name = nickname.value.trim();
      if (!name) return;
      result.value = null;
      try {
        result.value = await stats.lookup(name, realm.value);
      } catch {
        // error surfaced via stats.error
      }
    }

    return () => (
      <div class="lookup-view">
        <h1 class="lookup-view__title">{t("nav.lookup")}</h1>
        <div class="lookup-view__search">
          <select
            class="lookup-view__realm"
            value={realm.value}
            onChange={(e) => (realm.value = (e.target as HTMLSelectElement).value)}
          >
            {realms.map((r) => (
              <option value={r}>{r.toUpperCase()}</option>
            ))}
          </select>
          <input
            class="lookup-view__input"
            type="text"
            placeholder={t("account.nickname")}
            value={nickname.value}
            onInput={(e) => (nickname.value = (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
          />
          <SButton onClick={() => void search()} disabled={stats.loading}>
            {stats.loading ? t("account.searching") : t("account.search")}
          </SButton>
        </div>

        {stats.error ? (
          <div class="lookup-view__error">{stats.error}</div>
        ) : null}

        {result.value ? (
          <div class="lookup-view__result">
            <StatsCard stats={result.value} />
          </div>
        ) : null}
      </div>
    );
  },
});
