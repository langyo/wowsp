import { defineComponent, onMounted, ref } from "vue";
import { X, Trophy, Swords, Anchor } from "lucide-vue-next";

import SModal from "@/components/base/SModal";
import SButton from "@/components/base/SButton";
import SSelect from "@/components/base/SSelect";
import STag from "@/components/base/STag";
import PlayerBadge from "@/components/base/PlayerBadge";
import { useAccountStore, type AccountProfile } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { winrateColor } from "@/utils/winrate";
import { t } from "@/i18n";
import type { PlayerStats } from "@/api";
import "./AccountSwitcherModal.scss";

/**
 * Account binder / switcher modal. 4 realms (ru/eu/na/asia), search by
 * nickname → WG API resolves account_id → user confirms bind. Lists all bound
 * accounts as **rich cards** (clan tag, winrate, battles) instead of plain
 * rows — selecting a card switches the active account (no separate checkmark
 * button).
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
    // Per-account stats cache (hydrated on modal open).
    const statsById = ref<Map<string, PlayerStats>>(new Map());

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
        statsById.value.set(`${profile.realm}_${profile.accountId}`, result);
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

    async function remove(profile: AccountProfile, e: MouseEvent) {
      e.stopPropagation();
      await accounts.removeAccount(profile.realm, profile.accountId);
    }

    /** Hydrate cached stats for every bound account so cards can show
     *  winrate/battles/clan without re-hitting the WG API. */
    async function hydrateStats() {
      for (const a of accounts.accounts) {
        const cached = await stats.loadCached(a.realm, a.accountId);
        if (cached) statsById.value.set(`${a.realm}_${a.accountId}`, cached);
      }
    }

    onMounted(() => {
      void hydrateStats();
    });

    return () => (
      <SModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("account.switcherTitle")}
        width="34rem"
      >
        <div class="acct-modal">
          {/* search / bind */}
          <div class="acct-modal__search">
            <SSelect
              size="sm"
              modelValue={searchRealm.value}
              onUpdate:modelValue={(v: string) => (searchRealm.value = v)}
              options={realms.map((r) => ({ value: r, label: r.toUpperCase() }))}
            />
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
              loading={searching.value}
              disabled={!searchName.value.trim()}
              onClick={() => void doSearch()}
            >
              {t("account.search")}
            </SButton>
          </div>
          {searchError.value ? (
            <p class="acct-modal__error">{searchError.value}</p>
          ) : null}

          {/* bound accounts as cards */}
          <div class="acct-modal__list">
            {accounts.accounts.length === 0 ? (
              <p class="acct-modal__empty">{t("account.noAccounts")}</p>
            ) : (
              accounts.accounts.map((a) => {
                const isActive =
                  accounts.activeAccountId === a.accountId &&
                  accounts.activeRealm === a.realm;
                const s = statsById.value.get(`${a.realm}_${a.accountId}`);
                return (
                  <div
                    class={[
                      "acct-card",
                      isActive ? "acct-card--active" : "",
                    ]}
                    onClick={() => void switchTo(a)}
                  >
                    {/* Player service-record badge based on leveling tier.
                        Falls back to tier 0 (bronze "?") when stats not yet
                        loaded. Replaces the old pig-logo placeholder. */}
                    <PlayerBadge tier={s?.levelingTier ?? 0} dogTag={s?.dogTag ?? null} size={38} />
                    <div class="acct-card__body">
                      <div class="acct-card__head">
                        {s?.clanTag ? (
                          <span class="acct-card__clan">[{s.clanTag}]</span>
                        ) : null}
                        <span class="acct-card__name">{a.nickname}</span>
                      </div>
                      <div class="acct-card__meta">
                        <STag variant="neutral" size="sm">{a.realm.toUpperCase()}</STag>
                        {s ? (
                          <>
                            {s.battles != null ? (
                              <span class="acct-card__stat" title={t("stats.battles")}>
                                <Swords size={11} /> {s.battles.toLocaleString()}
                              </span>
                            ) : null}
                            {s.winrate != null ? (
                              <span
                                class="acct-card__stat"
                                style={{ color: winrateColor(s.winrate) }}
                                title={t("stats.winrate")}
                              >
                                <Trophy size={11} /> {s.winrate.toFixed(1)}%
                              </span>
                            ) : null}
                            {s.hidden ? (
                              <STag variant="danger" size="sm">{t("stats.hidden")}</STag>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </div>
                    <button
                      class="acct-card__remove"
                      onClick={(e) => void remove(a, e)}
                      aria-label={t("account.remove")}
                    >
                      <X size={14} />
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
