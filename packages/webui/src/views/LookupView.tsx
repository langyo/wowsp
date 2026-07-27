import { defineComponent, ref } from "vue";

import StatsCard from "@/components/stats/StatsCard";
import SButton from "@/components/base/SButton";
import SSelect from "@/components/base/SSelect";
import { useStatsStore } from "@/stores/stats";
import { useToast } from "@/composables/useToast";
import type { PlayerStats } from "@/api";
import { t } from "@/i18n";
import "./LookupView.scss";

export default defineComponent({
  name: "LookupView",
  setup() {
    const stats = useStatsStore();
    const toast = useToast();
    const nickname = ref("");
    const realm = ref("asia");
    const realms = ["ru", "eu", "na", "asia"];
    const result = ref<PlayerStats | null>(null);

    async function search() {
      const name = nickname.value.trim();
      if (!name) return;
      result.value = null;
      const toastId = toast.loading(t("account.searching"));
      try {
        result.value = await stats.lookup(name, realm.value);
      } catch {
        // error surfaced via stats.error
      } finally {
        toast.dismiss(toastId);
      }
    }

    return () => (
      <div class="lookup-view">
        <h1 class="lookup-view__title">{t("nav.lookup")}</h1>
        <div class="lookup-view__search">
          <SSelect
            modelValue={realm.value}
            onUpdate:modelValue={(v: string) => (realm.value = v)}
            options={realms.map((r) => ({ value: r, label: r.toUpperCase() }))}
          />
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
          <SButton size="md" onClick={() => void search()} loading={stats.loading}>
            {t("account.search")}
          </SButton>
        </div>

        {stats.error ? (
          <div class="lookup-view__error">{stats.error}</div>
        ) : null}

        <Transition name="s-fade-slide" mode="out-in">
          {result.value ? (
            <div class="lookup-view__result" key="result">
              <StatsCard stats={result.value} />
            </div>
          ) : null}
        </Transition>
      </div>
    );
  },
});
