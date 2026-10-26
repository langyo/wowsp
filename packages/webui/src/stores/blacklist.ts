/** Blacklist sync store (黑名单同步): the OpenID binding, the synced
 *  snapshot, the sync knobs, and the marker lookup every battle surface
 *  shares (overlay reads the backend command directly — it is bare DOM).
 *
 *  Matching contract: isBlocked(realm, accountId) — BOTH halves must agree,
 *  so a row resolved on another realm can never light the dot. The snapshot
 *  loads lazily per realm and survives until the next sync replaces it
 *  wholesale: the game is the source of truth, and its own contact churn
 *  (auto-unblocking of deleted accounts) reconciles on the next pull. */
import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { api } from "@/api";
import type {
  BlacklistAuthState,
  BlacklistSnapshot,
  BlacklistSyncConfig,
  BlacklistSyncReport,
} from "@/api";

/** Realms the sync supports (cn has no public API — see wg_realm.rs). */
export const SUPPORTED_BLACKLIST_REALMS = ["eu", "na", "asia", "ru"] as const;
export type BlacklistRealm = (typeof SUPPORTED_BLACKLIST_REALMS)[number];

export const useBlacklistStore = defineStore("blacklist", () => {
  const realm = ref<BlacklistRealm | "">("");
  const auth = ref<BlacklistAuthState | null>(null);
  const snapshot = ref<BlacklistSnapshot | null>(null);
  const config = ref<BlacklistSyncConfig>({ autoSync: true, intervalHours: 24 });
  const loading = ref(false);
  const syncing = ref(false);
  const lastReport = ref<BlacklistSyncReport | null>(null);
  /** Login URL shown for manual copy/paste while a flow is open. */
  const loginUrl = ref<string | null>(null);
  let loadedRealm = "";

  const blockedIds = computed(
    () => new Set(snapshot.value?.entries.map((entry) => entry.accountId) ?? []),
  );

  /** Load one realm's binding + snapshot + knobs once (idempotent). */
  async function ensureRealm(target: BlacklistRealm): Promise<void> {
    if (loadedRealm === target && !loading.value) return;
    loading.value = true;
    try {
      realm.value = target;
      const [authState, snap, cfg] = await Promise.all([
        api.blacklistAuthState(target),
        api.blacklistSnapshot(target),
        api.blacklistLoadConfig(),
      ]);
      auth.value = authState;
      snapshot.value = snap;
      config.value = cfg;
      loadedRealm = target;
    } finally {
      loading.value = false;
    }
  }

  /** The marker lookup. Fails closed (false) on any missing half — a bare
   *  id without a realm still matches when the snapshot realm is bound. */
  function isBlocked(
    queryRealm: string | null | undefined,
    accountId: number | null | undefined,
  ): boolean {
    if (!accountId || !snapshot.value) return false;
    if (queryRealm && queryRealm !== snapshot.value.realm) return false;
    return blockedIds.value.has(accountId);
  }

  async function refreshAuth(target = realm.value as BlacklistRealm): Promise<void> {
    if (!target) return;
    auth.value = await api.blacklistAuthState(target);
  }

  /** One pull; failures land in the report (the backend never rejects). */
  async function syncNow(target = realm.value as BlacklistRealm): Promise<BlacklistSyncReport | null> {
    if (!target || syncing.value) return null;
    syncing.value = true;
    try {
      const report = await api.blacklistSyncNow(target);
      lastReport.value = report;
      if (report.ok) snapshot.value = await api.blacklistSnapshot(target);
      return report;
    } finally {
      syncing.value = false;
      await refreshAuth(target);
    }
  }

  /** The auto-sync gate: logged in + enabled + stale past the interval.
   *  The app calls this on boot and on a low-frequency timer — the backend
   *  stays request/response and owns no schedule. */
  async function autoSyncIfDue(): Promise<void> {
    if (!config.value.autoSync || !auth.value?.loggedIn || !realm.value) return;
    const elapsedSec = Date.now() / 1000 - (snapshot.value?.lastSyncedAt ?? 0);
    if (elapsedSec < config.value.intervalHours * 3600) return;
    await syncNow();
  }

  /** Opens the portal login page (system browser) and records the URL for
   *  the manual copy/paste fallback. Poll auth state for the outcome. */
  async function startLogin(): Promise<void> {
    if (!realm.value) return;
    loginUrl.value = await api.blacklistAuthStart(realm.value);
  }

  /** Closes a pending flow (also fired when the section unmounts). */
  function endLogin(): void {
    if (!loginUrl.value) return;
    loginUrl.value = null;
    void api.blacklistAuthCancel();
  }

  async function forget(): Promise<void> {
    if (!realm.value) return;
    await api.blacklistAuthForget(realm.value);
    lastReport.value = null;
    await refreshAuth(realm.value);
  }

  async function saveConfig(): Promise<void> {
    config.value = await api.blacklistSaveConfig(config.value);
  }

  return {
    realm,
    auth,
    snapshot,
    config,
    loading,
    syncing,
    lastReport,
    loginUrl,
    ensureRealm,
    isBlocked,
    refreshAuth,
    syncNow,
    autoSyncIfDue,
    startLogin,
    endLogin,
    forget,
    saveConfig,
  };
});
