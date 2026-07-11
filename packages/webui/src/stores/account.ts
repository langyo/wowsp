import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api } from "@/api";

/** One bound Wargaming account (no login — just a remembered profile). */
export interface AccountProfile {
  accountId: number;
  nickname: string;
  realm: string; // ru | eu | na | asia
}

const ACCOUNTS_FILE = "accounts.json";

export const useAccountStore = defineStore("account", () => {
  const accounts = ref<AccountProfile[]>([]);
  const activeRealm = ref<string>(localStorage.getItem("wowsp-active-realm") || "asia");
  const activeAccountId = ref<number | null>(
    Number(localStorage.getItem("wowsp-active-account")) || null,
  );
  const loading = ref(false);

  const activeAccount = computed(() =>
    accounts.value.find((a) => a.accountId === activeAccountId.value) ?? null,
  );

  /** Load accounts from AppData on startup. */
  async function load() {
    loading.value = true;
    try {
      const raw = await api.appdataRead(ACCOUNTS_FILE);
      if (raw) {
        const data = JSON.parse(raw);
        accounts.value = Array.isArray(data.accounts) ? data.accounts : [];
        if (data.activeAccountId) activeAccountId.value = data.activeAccountId;
        if (data.activeRealm) activeRealm.value = data.activeRealm;
      }
    } catch {
      // file doesn't exist yet — that's fine
    } finally {
      loading.value = false;
    }
  }

  /** Persist accounts + active selection to AppData. */
  async function persist() {
    const data = JSON.stringify({
      accounts: accounts.value,
      activeAccountId: activeAccountId.value,
      activeRealm: activeRealm.value,
    });
    await api.appdataWrite(ACCOUNTS_FILE, data);
    localStorage.setItem("wowsp-active-realm", activeRealm.value);
    if (activeAccountId.value) {
      localStorage.setItem("wowsp-active-account", String(activeAccountId.value));
    }
  }

  /** Add a new account profile (after WG API search confirms accountId). */
  async function addAccount(profile: AccountProfile) {
    // De-dupe by (realm, accountId).
    if (!accounts.value.some((a) => a.realm === profile.realm && a.accountId === profile.accountId)) {
      accounts.value.push(profile);
    }
    await persist();
  }

  /** Remove an account profile. */
  async function removeAccount(realm: string, accountId: number) {
    accounts.value = accounts.value.filter((a) => !(a.realm === realm && a.accountId === accountId));
    if (activeAccountId.value === accountId) activeAccountId.value = null;
    await persist();
  }

  /** Switch the active account. */
  async function setActive(realm: string, accountId: number) {
    activeRealm.value = realm;
    activeAccountId.value = accountId;
    await persist();
  }

  return {
    accounts,
    activeRealm,
    activeAccountId,
    activeAccount,
    loading,
    load,
    addAccount,
    removeAccount,
    setActive,
  };
});
