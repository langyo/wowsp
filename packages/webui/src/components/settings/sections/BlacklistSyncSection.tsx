/** Blacklist sync settings section (黑名单同步): bind a WG / Lesta account
 *  via OpenID, pull the in-game blacklist on demand or on schedule, and
 *  review the synced list. Read-only by design — the public API exposes no
 *  write path and the game stays the source of truth; the battle surfaces
 *  consume the same store to light the ship-marker dot. */
import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";
import type { PropType } from "vue";
import {
  HkButton,
  HkInput,
  HkScrollContainer,
  HkSettingsGroup,
  HkSettingsHint,
  HkSwitch,
  HkTabs,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import { type BlacklistEntry } from "@/api";
import {
  SUPPORTED_BLACKLIST_REALMS,
  useBlacklistStore,
  type BlacklistRealm,
} from "@/stores/blacklist";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import "./BlacklistSyncSection.scss";

/** Proper nouns — no per-locale spellings needed. */
const REALM_LABELS: Record<BlacklistRealm, string> = {
  eu: "EU",
  na: "NA",
  asia: "Asia",
  ru: "RU · Lesta",
};

export default defineComponent({
  name: "SettingsBlacklistSyncSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup() {
    const store = useBlacklistStore();
    const realm = ref<BlacklistRealm>("eu");
    void store.ensureRealm(realm.value);
    watch(realm, (next) => void store.ensureRealm(next));

    // ── login flow: poll the binding while a callback listener is open ──
    let poll: ReturnType<typeof setInterval> | null = null;
    function stopPoll(): void {
      if (poll !== null) {
        clearInterval(poll);
        poll = null;
      }
    }
    function startPoll(): void {
      stopPoll();
      poll = setInterval(() => {
        void (async () => {
          await store.refreshAuth();
          if (store.auth?.loggedIn) {
            // Binding landed — pull the fresh blacklist right away.
            store.endLogin();
            stopPoll();
            await store.syncNow();
          }
        })();
      }, 2000);
    }
    watch(
      () => store.loginUrl,
      (url) => {
        if (url) startPoll();
        else stopPoll();
      },
    );
    onBeforeUnmount(() => {
      store.endLogin();
      stopPoll();
    });

    // ── list search ──
    const search = ref("");
    const filtered = computed<BlacklistEntry[]>(() => {
      const entries = store.snapshot?.entries ?? [];
      const q = search.value.trim().toLowerCase();
      if (!q) return entries;
      return entries.filter(
        (entry) =>
          (entry.nickname ?? "").toLowerCase().includes(q) || String(entry.accountId).includes(q),
      );
    });

    // ── interval commit (the same input+Save grammar as the proxy URL) ──
    const intervalInput = ref(String(store.config.intervalHours));
    watch(
      () => store.config.intervalHours,
      (hours) => {
        intervalInput.value = String(hours);
      },
    );
    const intervalDirty = computed(
      () => Number.parseInt(intervalInput.value, 10) !== store.config.intervalHours,
    );
    async function saveInterval(): Promise<void> {
      const hours = Number.parseInt(intervalInput.value, 10);
      if (Number.isNaN(hours)) return;
      store.config = { ...store.config, intervalHours: hours };
      await store.saveConfig();
    }

    const tokenExpired = computed(() => {
      const expires = store.auth?.expiresAt;
      return expires != null && expires * 1000 < Date.now();
    });
    const lastSyncText = computed(() => {
      const stamp = store.snapshot?.lastSyncedAt;
      return stamp ? new Date(stamp * 1000).toLocaleString() : t("settings.blacklistNever");
    });
    const countText = computed(() =>
      t("settings.blacklistCount", { n: store.snapshot?.entries.length ?? 0 }),
    );

    function realmTabs() {
      return SUPPORTED_BLACKLIST_REALMS.map((r) => ({ key: r, label: REALM_LABELS[r] }));
    }

    return () => (
      <>
        <HkSettingsGroup title={t("settings.blacklistSync")}>
          <HkSettingsHint>{t("settings.blacklistSyncHint")}</HkSettingsHint>
          <HkTabs
            block
            variant="segmented"
            modelValue={realm.value}
            onUpdate:modelValue={(v: string) => (realm.value = v as BlacklistRealm)}
            tabs={realmTabs()}
          />

          {/* binding card: logged-in identity or the login flow */}
          <div class="blacklist-sync__status">
            {store.auth?.loggedIn ? (
              <span class="blacklist-sync__bound">
                {t("settings.blacklistBoundAs")}
                {" "}
                <strong>{store.auth.nickname}</strong>
                {tokenExpired.value ? (
                  <span class="blacklist-sync__expired">{t("settings.blacklistReLoginDue")}</span>
                ) : (
                  <span class="blacklist-sync__muted">
                    {t("settings.blacklistTokenExpire")}
                    {" "}
                    {new Date((store.auth.expiresAt ?? 0) * 1000).toLocaleString()}
                  </span>
                )}
              </span>
            ) : (
              <span class="blacklist-sync__muted">{t("settings.blacklistNotLoggedIn")}</span>
            )}
            <div class="blacklist-sync__actions">
              <HkButton
                size="sm"
                disabled={store.auth?.loggedIn === true}
                onClick={() => void store.startLogin()}
              >
                {store.loginUrl
                  ? t("settings.blacklistLoginPending")
                  : t("settings.blacklistLogin")}
              </HkButton>
              {store.auth?.loggedIn ? (
                <HkButton size="sm" onClick={() => void store.forget()}>
                  {t("settings.blacklistLogout")}
                </HkButton>
              ) : null}
            </div>
          </div>
          {store.loginUrl ? (
            <div class="blacklist-sync__manual">
              <HkSettingsHint>{t("settings.blacklistLoginManualHint")}</HkSettingsHint>
              <div class="blacklist-sync__manual-row">
                <div class="blacklist-sync__manual-input">
                  <HkInput modelValue={store.loginUrl} readonly />
                </div>
                <HkButton size="sm" onClick={() => store.endLogin()}>
                  {t("settings.blacklistLoginCancel")}
                </HkButton>
              </div>
            </div>
          ) : null}
        </HkSettingsGroup>

        <HkSettingsGroup title={t("settings.blacklistSyncSettings")}>
          <div class="blacklist-sync__row">
            <HkSwitch
              size="sm"
              modelValue={store.config.autoSync}
              onUpdate:modelValue={(v: boolean) => {
                store.config = { ...store.config, autoSync: v };
                void store.saveConfig();
              }}
            >
              {t("settings.blacklistAutoSync")}
            </HkSwitch>
          </div>
          <div class="blacklist-sync__row">
            <span class="blacklist-sync__muted">{t("settings.blacklistIntervalHours")}</span>
            <div class="blacklist-sync__manual-row">
              <div class="blacklist-sync__manual-input">
                <HkInput
                  modelValue={intervalInput.value}
                  onUpdate:modelValue={(v: string) => (intervalInput.value = v)}
                  submitOnEnter={() => void saveInterval()}
                />
              </div>
              <HkButton size="sm" disabled={!intervalDirty.value} onClick={() => void saveInterval()}>
                {t("settings.blacklistSave")}
              </HkButton>
            </div>
          </div>
          <div class="blacklist-sync__row">
            <span class="blacklist-sync__muted">
              {t("settings.blacklistLastSync")}: {lastSyncText.value}
              {" · "}
              {countText.value}
            </span>
            <HkButton
              size="sm"
              disabled={store.syncing || !store.auth?.loggedIn}
              onClick={() => void store.syncNow()}
            >
              {store.syncing ? t("settings.blacklistSyncing") : t("settings.blacklistSyncNow")}
            </HkButton>
          </div>
          {store.lastReport ? (
            <div class="blacklist-sync__report">
              {store.lastReport.ok
                ? t("settings.blacklistSyncOk", { n: store.lastReport.fetched })
                : t("settings.blacklistSyncFailed", {
                    msg: store.lastReport.message ?? "",
                  })}
            </div>
          ) : null}
        </HkSettingsGroup>

        <HkSettingsGroup title={t("settings.blacklistListTitle")}>
          <div class="blacklist-sync__row">
            <div class="blacklist-sync__manual-row">
              <div class="blacklist-sync__manual-input">
                <HkInput
                  modelValue={search.value}
                  onUpdate:modelValue={(v: string) => (search.value = v)}
                  placeholder={t("settings.blacklistSearchPlaceholder")}
                />
              </div>
              <span class="blacklist-sync__muted">{countText.value}</span>
            </div>
          </div>
          <HkScrollContainer class="blacklist-sync__list">
            <div class="blacklist-sync__list-inner">
              {filtered.value.length === 0 ? (
                <p class="blacklist-sync__muted">{t("settings.blacklistEmpty")}</p>
              ) : (
                filtered.value.map((entry) => (
                  <div class="blacklist-sync__entry" key={entry.accountId}>
                    <span class="blacklist-sync__entry-name">
                      {entry.nickname ?? t("settings.blacklistNoNickname")}
                    </span>
                    <span class="blacklist-sync__entry-id">{entry.accountId}</span>
                  </div>
                ))
              )}
            </div>
          </HkScrollContainer>
          {(store.snapshot?.unresolved ?? 0) > 0 ? (
            <HkSettingsHint>
              {t("settings.blacklistUnresolvedNote", { n: store.snapshot?.unresolved ?? 0 })}
            </HkSettingsHint>
          ) : null}
        </HkSettingsGroup>
      </>
    );
  },
});
