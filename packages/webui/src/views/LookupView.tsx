import { defineComponent, ref } from "vue";
import { t } from "@/i18n";
import SButton from "@/components/base/SButton";
import "./LookupView.scss";

/**
 * Stats lookup page. Search box (nickname + realm) → WG API query → deep
 * stats display. The actual API call + stats card lands in a subsequent step.
 */
export default defineComponent({
  name: "LookupView",
  setup() {
    const nickname = ref("");
    const realm = ref("asia");
    const realms = ["ru", "eu", "na", "asia"];

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
          />
          <SButton onClick={() => { /* TODO: WG API query */ }}>
            {t("account.search")}
          </SButton>
        </div>
      </div>
    );
  },
});
