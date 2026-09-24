import { defineComponent, ref, watch, type PropType } from "vue";
import { X, Trophy, Swords, Star, Plus } from "@lucide/vue";

import { HkButton, HkInput, HkModal, HkSelect, HkTag } from "@celestia-island/hikari";

import PlayerBadge from "@/components/base/PlayerBadge";
import { useAccountStore, type AccountProfile } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { winrateColor } from "@/utils/winrate";
import { t } from "@/i18n";
import type { PlayerStats } from "@/api";
import "./AccountManagerContent.scss";

/**
 * Account binder / switcher body — the shell-agnostic part of account
 * management: all bound accounts as rich cards (clan tag, winrate, battles)
 * plus a dashed "add player" row at the end of the list. The row opens a
 * dialog that searches by nickname → WG API resolves account_id → the found
 * player is previewed → confirm binds and activates it. Selecting a card
 * switches the active account (no separate checkmark button).
 *
 * Rendered inline in the settings modal's 账户 section AND inside the
 * AccountSwitcherModal wrapper (dashboard's bind entry). Hosts that need to
 * react to a bind/switch (close + refresh) pass `onActive`.
 */
export default defineComponent({
  name: "AccountManagerContent",
  props: {
    /** Called after a successful bind or switch (host decides what to do —
     *  the modal wrapper closes itself, the settings section stays open). */
    onActive: { type: Function as PropType<() => void>, default: undefined },
  },
  setup(props) {
    const accounts = useAccountStore();
    const stats = useStatsStore();

    const searchRealm = ref("asia");
    const searchName = ref("");
    const searching = ref(false);
    const searchError = ref<string | null>(null);
    const realms = ["ru", "eu", "na", "asia", "cn"];
    /** Whether the add-player dialog is open. */
    const addOpen = ref(false);
    /** Player resolved by the lookup step, awaiting confirmation. */
    const found = ref<{ profile: AccountProfile; stats: PlayerStats } | null>(null);
    const binding = ref(false);
    // Per-account stats cache (hydrated from the local cache so cards can
    // show winrate/battles/clan without re-hitting the WG API).
    const statsById = ref<Map<string, PlayerStats>>(new Map());

    /** Bumped by every event that invalidates a lookup in flight: a new
     *  query, a realm switch, the dialog being reopened. `doSearch` stamps
     *  its own attempt with the value it took at launch and drops the
     *  result when the counter has moved on, so a stale response can never
     *  stage a preview into a dialog that no longer asked for it. */
    let searchSeq = 0;

    /** Open the add dialog from the dashed list row — start from a clean
     *  slate (no stale query / preview / error from a previous visit). */
    function openAdd() {
      // Reopening invalidates an attempt still in flight: it was aimed at
      // the previous visit's query and must not stage a preview here.
      searchSeq++;
      searchError.value = null;
      found.value = null;
      searchName.value = "";
      addOpen.value = true;
    }

    /** Floor under the search button's busy state (ms).
     *
     *  A lookup that the stats cache can answer lands in a couple of
     *  animation frames, and Vue's scheduler flips the ring back off in the
     *  same frame that painted it: measured 2 frames out of ~500 over a 3s
     *  window, i.e. the search button looked like it never reacted to the
     *  tap (user report 2026-09-24, phone — "the ring isn't there"). The
     *  floor holds `searching` long enough for the ring to register as a
     *  busy state on every path, cached or not. */
    const SEARCH_BUSY_FLOOR_MS = 400;

    /** Lookup-only step: resolve the nickname on the selected realm and
     *  stage it as the preview; the actual bind happens in confirmAdd.
     *  The query and the staged profile both use the realm captured when
     *  the search started — reading `searchRealm` again after the await
     *  could pair one realm's account_id with another realm's label and
     *  bind the wrong account. */
    async function doSearch() {
      const name = searchName.value.trim();
      if (!name || searching.value) return;
      const realm = searchRealm.value;
      const seq = ++searchSeq;
      const startedAt = Date.now();
      searching.value = true;
      searchError.value = null;
      // Any new query invalidates the previously staged preview (a failed
      // re-search must not leave the old player confirmable).
      found.value = null;
      try {
        // lookup also resolves the account_id + caches stats.
        //
        // force: an explicit query must re-pull from the WG API — that is
        // the documented rule for user-driven lookups (the lookup page and
        // the dashboard refresh both pass it). Without it a nickname the
        // cache already knows resolved from disk and the dialog previewed
        // possibly-months-old stats as if they were the bind's source of
        // truth, while the busy ring never had a reason to stay up.
        const result = await stats.lookup(name, realm, { force: true });
        if (seq !== searchSeq) return;
        found.value = {
          profile: { accountId: result.accountId, nickname: result.name, realm },
          stats: result,
        };
      } catch (e) {
        if (seq !== searchSeq) return;
        searchError.value = (e as Error).message;
      } finally {
        // Hold the ring to the floor before clearing the busy state (see
        // SEARCH_BUSY_FLOOR_MS) so a cache-fast lookup still reads as busy.
        const remaining = SEARCH_BUSY_FLOOR_MS - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
        // Clearing unconditionally is safe because `doSearch` refuses to
        // start while `searching` is set: only one attempt is ever in
        // flight, so this release can never land on a newer attempt's ring
        // (a superseded attempt returns here and simply stops early).
        searching.value = false;
      }
    }

    /** Bind the staged player and make it active; seed the stats cache so
     *  the new card shows winrate/battles/clan immediately. */
    async function confirmAdd() {
      const f = found.value;
      if (!f || binding.value) return;
      binding.value = true;
      try {
        await accounts.addAccount(f.profile);
        await accounts.setActive(f.profile.realm, f.profile.accountId);
        statsById.value.set(`${f.profile.realm}_${f.profile.accountId}`, f.stats);
        found.value = null;
        searchName.value = "";
        addOpen.value = false;
        props.onActive?.();
      } catch (e) {
        searchError.value = (e as Error).message;
      } finally {
        binding.value = false;
      }
    }

    async function switchTo(profile: AccountProfile) {
      await accounts.setActive(profile.realm, profile.accountId);
      props.onActive?.();
    }

    async function remove(profile: AccountProfile, e: MouseEvent) {
      e.stopPropagation();
      await accounts.removeAccount(profile.realm, profile.accountId);
    }

    /** Promote to the realm's preferred account (the ✦ server switches land
     *  on it). Only offered when the realm has more than one bound account. */
    async function promote(profile: AccountProfile, e: MouseEvent) {
      e.stopPropagation();
      await accounts.setPreferred(profile.realm, profile.accountId);
    }

    /** Hydrate cached stats for every bound account so cards can show
     *  winrate/battles/clan without re-hitting the WG API. */
    async function hydrateStats() {
      for (const a of accounts.accounts) {
        const key = a.realm + "_" + a.accountId;
        if (statsById.value.has(key)) continue;
        const cached = await stats.loadCached(a.realm, a.accountId);
        if (cached) statsById.value.set(key, cached);
      }
    }

    // Accounts load asynchronously in AppShell onMounted; this content may
    // render before they arrive, so hydrate immediately AND whenever the
    // list changes (new bind adds a card with stats already in cache).
    watch(
      () => accounts.accounts.length,
      () => void hydrateStats(),
      { immediate: true },
    );

    return () => (
      <div class="acct-modal">
        {/* bound accounts as cards + the dashed add row closing the list */}
        <div class="acct-modal__list">
          {accounts.accounts.length === 0 ? (
            <p class="acct-modal__empty">{t("account.noAccounts")}</p>
          ) : (
            accounts.accounts.map((a) => {
              const isActive =
                accounts.activeAccountId === a.accountId &&
                accounts.activeRealm === a.realm;
              const s = statsById.value.get(`${a.realm}_${a.accountId}`);
              const preferred = accounts.preferredAccount(a.realm);
              const isPreferred = preferred?.accountId === a.accountId;
              const realmHasChoice =
                accounts.accounts.filter((x) => x.realm === a.realm).length > 1;
              return (
                <div
                  key={`${a.realm}_${a.accountId}`}
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
                      {isPreferred ? (
                        <span class="acct-card__preferred" data-hint={t("account.preferred")}>
                          <Star size={11} />
                        </span>
                      ) : null}
                    </div>
                    <div class="acct-card__meta">
                      <HkTag variant="default" size="sm">{a.realm.toUpperCase()}</HkTag>
                      {s ? (
                        [
                          s.battles != null ? (
                            <span class="acct-card__stat" data-hint={t("stats.battles")}>
                              <Swords size={11} /> {s.battles.toLocaleString()}
                            </span>
                          ) : null,
                          s.winrate != null ? (
                            <span
                              class="acct-card__stat"
                              style={{ color: winrateColor(s.winrate) }}
                              data-hint={t("stats.winrate")}
                            >
                              <Trophy size={11} /> {s.winrate.toFixed(1)}%
                            </span>
                          ) : null,
                          s.hidden ? (
                            <HkTag variant="danger" size="sm">{t("stats.hidden")}</HkTag>
                          ) : null,
                        ]
                      ) : null}
                    </div>
                  </div>
                  {!isPreferred && realmHasChoice ? (
                    <button
                      class="acct-card__promote"
                      onClick={(e) => void promote(a, e)}
                      aria-label={t("account.setPreferred")}
                      data-hint={t("account.setPreferred")}
                    >
                      <Star size={14} />
                    </button>
                  ) : null}
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
          {/* dashed add placeholder — the last row of the list; opens the
              search → confirm-bind dialog instead of an inline search row. */}
          <button type="button" class="acct-modal__add" onClick={openAdd}>
            <Plus size={14} /> {t("account.addPlayer")}
          </button>
        </div>

        {/* add-player dialog — search by nickname, preview the resolved
            player, then confirm the bind (two-step instead of the old
            search-binds-immediately row). */}
        <HkModal
          modelValue={addOpen.value}
          onUpdate:modelValue={(v: boolean) => (addOpen.value = v)}
          title={t("account.addPlayer")}
          width="30rem"
          // Phone sheet keeps the height the staged result needs up front
          // (see .acct-add-modal in AccountManagerContent.scss).
          contentClass="acct-add-modal"
        >
          <div class="acct-modal__search">
            <HkSelect
              modelValue={searchRealm.value}
              onUpdate:modelValue={(v: string) => {
                searchRealm.value = v;
                // The staged preview belongs to the realm it was found on,
                // and an attempt still in flight was aimed at the previous
                // one — drop both rather than let the old realm's result
                // stage against the new realm's label.
                searchSeq++;
                found.value = null;
              }}
              options={realms.map((r) => ({ value: r, label: r.toUpperCase() }))}
            />
            <HkInput
              modelValue={searchName.value}
              onUpdate:modelValue={(v: string) => (searchName.value = v)}
              placeholder={t("account.nickname")}
              submitOnEnter={() => void doSearch()}
            />
            <HkButton
              size="sm"
              loading={searching.value}
              disabled={!searchName.value.trim()}
              onClick={() => void doSearch()}
            >
              {t("account.search")}
            </HkButton>
          </div>
          {searchError.value ? (
            <p class="acct-modal__error">{searchError.value}</p>
          ) : null}
          {found.value ? (
            <>
              {/* preview of the resolved player — same anatomy as the
                  account cards but inert: no click-to-switch, no remove /
                  promote buttons. */}
              <div class="acct-card acct-card--preview">
                <PlayerBadge
                  tier={found.value.stats.levelingTier ?? 0}
                  dogTag={found.value.stats.dogTag ?? null}
                  size={38}
                />
                <div class="acct-card__body">
                  <div class="acct-card__head">
                    {found.value.stats.clanTag ? (
                      <span class="acct-card__clan">[{found.value.stats.clanTag}]</span>
                    ) : null}
                    <span class="acct-card__name">{found.value.profile.nickname}</span>
                  </div>
                  <div class="acct-card__meta">
                    <HkTag variant="default" size="sm">
                      {found.value.profile.realm.toUpperCase()}
                    </HkTag>
                    {found.value.stats.battles != null ? (
                      <span class="acct-card__stat" data-hint={t("stats.battles")}>
                        <Swords size={11} /> {found.value.stats.battles.toLocaleString()}
                      </span>
                    ) : null}
                    {found.value.stats.winrate != null ? (
                      <span
                        class="acct-card__stat"
                        style={{ color: winrateColor(found.value.stats.winrate) }}
                        data-hint={t("stats.winrate")}
                      >
                        <Trophy size={11} /> {found.value.stats.winrate.toFixed(1)}%
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div class="acct-modal__confirm">
                <HkButton
                  variant="primary"
                  loading={binding.value}
                  onClick={() => void confirmAdd()}
                >
                  {t("account.bind")}
                </HkButton>
              </div>
            </>
          ) : null}
        </HkModal>
      </div>
    );
  },
});
