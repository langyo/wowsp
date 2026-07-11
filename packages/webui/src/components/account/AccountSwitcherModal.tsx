import { defineComponent, ref, watch } from "vue";

import SModal from "@/components/base/SModal";
import SButton from "@/components/base/SButton";
import { useAccountStore, type AccountProfile } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { t } from "@/i18n";
import "./AccountSwitcherModal.scss";

/**
 * Account binder / switcher modal. 4 realms (ru/eu/na/asia), search by
 * nickname → WG API resolves account_id → user confirms bind. No login —
 * just a remembered profile. Lists all bound accounts with switch + remove.
 *
 * Emits `bound` after a successful add/switch so the parent (DashboardView)
 * can refresh stats.
 */
export default defineComponent({
  name: "AccountSwitcherModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    bound: () => true,
  },
  setup(props, { emit }) {
    const accounts = useAccountStore();
    const stats = useStatsStore();

    const searchRealm = ref("asia");
    const searchName = ref("");
    const searching = ref(false);
    const searchError = ref<string | null>(null);
    const realms = ["ru", "eu", "na", "asia"];

    async function doSearch() {
      const name = searchName.value.trim();
      if (!name) return;
      searching.value = true;
      searchError.value = null;
      try {
        // lookup also resolves the account_id + caches stats.
        const result = await stats.lookup(name, searchRealm.value);
        const profile: AccountProfile = {
          accountId: result.accountId,
          nickname: result.name,
          realm: searchRealm.value,
        };
        await accounts.addAccount(profile);
        await accounts.setActive(profile.realm, profile.accountId);
        searchName.value = "";
        emit("bound");
        emit("update:modelValue", false);
      } catch (e) {
        searchError.value = (e as Error).message;
      } finally {
        searching.value = false;
      }
    }

    async function switchTo(profile: AccountProfile) {
      await accounts.setActive(profile.realm, profile.accountId);
      emit("bound");
      emit("update:modelValue", false);
    }

    async function remove(profile: AccountProfile) {
      await accounts.removeAccount(profile.realm, profile.accountId);
    }

    return () => (
      <SModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("account.switcherTitle")}
        width="30rem"
      >
        <div class="acct-modal">
          {/* search / bind */}
          <div class="acct-modal__search">
            <select
              class="acct-modal__realm"
              value={searchRealm.value}
              onChange={(e) => (searchRealm.value = (e.target as HTMLSelectElement).value)}
            >
              {realms.map((r) => (
                <option value={r}>{r.toUpperCase()}</option>
              ))}
            </select>
            <input
              class="acct-modal__input"
              type="text"
              placeholder={t("account.nickname")}
              value={searchName.value}
              onInput={(e) => (searchName.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doSearch();
              }}
            />
            <SButton
              variant="primary"
              size="sm"
              disabled={searching.value || !searchName.value.trim()}
              onClick={() => void doSearch()}
            >
              {searching.value ? "..." : t("account.search")}
            </SButton>
          </div>
          {searchError.value ? (
            <p class="acct-modal__error">{searchError.value}</p>
          ) : null}

          {/* bound accounts list */}
          <div class="acct-modal__list">
            {accounts.accounts.length === 0 ? (
              <p class="acct-modal__empty">{t("account.noAccounts")}</p>
            ) : (
              accounts.accounts.map((a) => {
                const isActive =
                  accounts.activeAccountId === a.accountId &&
                  accounts.activeRealm === a.realm;
                return (
                  <div
                    class={[
                      "acct-modal__item",
                      isActive ? "acct-modal__item--active" : "",
                    ]}
                  >
                    <button class="acct-modal__item-main" onClick={() => void switchTo(a)}>
                      <span class="acct-modal__item-name">{a.nickname}</span>
                      <span class="acct-modal__item-realm">{a.realm.toUpperCase()}</span>
                      {isActive ? (
                        <span class="acct-modal__item-check">✓</span>
                      ) : null}
                    </button>
                    <button
                      class="acct-modal__item-remove"
                      onClick={() => void remove(a)}
                      aria-label="remove"
                    >
                      ✕
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </SModal>
    );
  },
});
