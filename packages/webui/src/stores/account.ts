import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api } from "@/api";
import { KNOWN_REALMS } from "@/utils/realms";

/** One bound Wargaming account (no login — just a remembered profile). */
export interface AccountProfile {
  accountId: number;
  nickname: string;
  realm: string; // ru | eu | na | asia | cn
}

const ACCOUNTS_FILE = "accounts.json";

/** The five WG realms an `activeRealm` value may carry (utils/realms — the
 *  one shared list). */
const REALMS = KNOWN_REALMS;

/** Seed the active realm from localStorage, validating against the realm
 *  list: a stale/garbage value resets to the default ("asia") AND is forced
 *  back to disk so the correction sticks (heal-write, same policy as the
 *  other persisted preferences). */
function loadActiveRealm(): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("wowsp-active-realm");
  } catch {
    saved = null;
  }
  if (saved && (REALMS as readonly string[]).includes(saved)) return saved;
  if (saved != null) {
    try {
      localStorage.setItem("wowsp-active-realm", "asia");
    } catch {
      // storage unavailable — the default holds for the session
    }
  }
  return "asia";
}

export const useAccountStore = defineStore("account", () => {
  const accounts = ref<AccountProfile[]>([]);
  const activeRealm = ref<string>(loadActiveRealm());
  const activeAccountId = ref<number | null>(
    Number(localStorage.getItem("wowsp-active-account")) || null,
  );
  /** realm → the account auto-switched to when that server/client becomes
   *  active. The first account bound on a realm becomes its preferred one;
   *  users can promote another from the account modal. */
  const preferredByRealm = ref<Record<string, number>>({});
  const loading = ref(false);
  let pendingLoad: Promise<void> | null = null;
  let pendingSave: Promise<void> = Promise.resolve();

  const activeAccount = computed(() =>
    accounts.value.find((a) => a.realm === activeRealm.value && a.accountId === activeAccountId.value) ?? null,
  );

  /** The preferred account for a realm (null when none is bound). */
  const preferredAccount = computed(
    () => (realm: string) => {
      const id = preferredByRealm.value[realm];
      if (id != null) {
        const hit = accounts.value.find((a) => a.realm === realm && a.accountId === id);
        if (hit) return hit;
      }
      return accounts.value.find((a) => a.realm === realm) ?? null;
    },
  );

  /** Load accounts from AppData on startup. */
  function load(): Promise<void> {
    if (pendingLoad) return pendingLoad;
    loading.value = true;
    pendingLoad = (async () => {
      // A reload must observe any saves already requested by this store.
      await pendingSave;
      try {
        const raw = await api.appdataRead(ACCOUNTS_FILE);
        if (raw) {
          const data = JSON.parse(raw);
          accounts.value = Array.isArray(data.accounts) ? data.accounts : [];
          if ("activeAccountId" in data) activeAccountId.value = data.activeAccountId ?? null;
          // Same realm validation as the localStorage seed — a corrupt file
          // value never overrides the default.
          if (
            typeof data.activeRealm === "string" &&
            (REALMS as readonly string[]).includes(data.activeRealm)
          ) {
            activeRealm.value = data.activeRealm;
          }
          preferredByRealm.value =
            typeof data.preferred === "object" && data.preferred != null ? data.preferred : {};
        }
      } catch {
        // file doesn't exist yet — that's fine
      } finally {
        loading.value = false;
        pendingLoad = null;
      }
    })();
    return pendingLoad;
  }

  /** Persist accounts + active selection + per-realm preferences to AppData. */
  async function persist() {
    const realm = activeRealm.value;
    const accountId = activeAccountId.value;
    const data = JSON.stringify({
      accounts: accounts.value,
      activeAccountId: activeAccountId.value,
      activeRealm: activeRealm.value,
      preferred: preferredByRealm.value,
    });
    // The transport may complete commands out of order. Keep the file,
    // fallback selection and session hub on the same captured snapshot.
    const save = pendingSave.then(async () => {
      await api.appdataWrite(ACCOUNTS_FILE, data);
      try {
        localStorage.setItem("wowsp-active-realm", realm);
        if (accountId != null) localStorage.setItem("wowsp-active-account", String(accountId));
        else localStorage.removeItem("wowsp-active-account");
      } catch {
        // The AppData file remains authoritative when browser storage fails.
      }
      await api.syncActiveAccount(realm, accountId).catch(() => undefined);
    });
    pendingSave = save.catch(() => undefined);
    await save;
  }

  /** Add a new account profile (after WG API search confirms accountId). The
   *  first account bound on a realm implicitly becomes its preferred one. */
  async function addAccount(profile: AccountProfile) {
    if (pendingLoad) await pendingLoad;
    // De-dupe by (realm, accountId).
    if (!accounts.value.some((a) => a.realm === profile.realm && a.accountId === profile.accountId)) {
      accounts.value.push(profile);
      if (preferredByRealm.value[profile.realm] == null) {
        preferredByRealm.value = { ...preferredByRealm.value, [profile.realm]: profile.accountId };
      }
    }
    await persist();
  }

  /** Remove an account profile (clearing a preference that pointed at it). */
  async function removeAccount(realm: string, accountId: number) {
    if (pendingLoad) await pendingLoad;
    accounts.value = accounts.value.filter((a) => !(a.realm === realm && a.accountId === accountId));
    if (activeRealm.value === realm && activeAccountId.value === accountId) activeAccountId.value = null;
    if (preferredByRealm.value[realm] === accountId) {
      const next = accounts.value.find((a) => a.realm === realm);
      const preferred = { ...preferredByRealm.value };
      if (next) preferred[realm] = next.accountId;
      else delete preferred[realm];
      preferredByRealm.value = preferred;
    }
    await persist();
  }

  /** Switch the active account. */
  async function setActive(realm: string, accountId: number) {
    if (pendingLoad) await pendingLoad;
    activeRealm.value = realm;
    activeAccountId.value = accountId;
    await persist();
  }

  /** Reorder the bound accounts (settings 账户 cards, drag handles). The
   *  array order IS the card order — `persist()` writes it straight into
   *  accounts.json, so a reorder survives a restart on its own. */
  async function reorderAccounts(from: number, to: number) {
    if (pendingLoad) await pendingLoad;
    const arr = [...accounts.value];
    const [moved] = arr.splice(from, 1);
    if (!moved) return;
    arr.splice(to, 0, moved);
    accounts.value = arr;
    await persist();
  }

  /** Promote an account to its realm's preferred one (the ✦/首选 button).
   *  The promoted card also floats to the front of its realm's run, so
   *  the list reads primary-first without touching the other realms'
   *  manual drag order. */
  async function setPreferred(realm: string, accountId: number) {
    if (pendingLoad) await pendingLoad;
    preferredByRealm.value = { ...preferredByRealm.value, [realm]: accountId };
    const arr = [...accounts.value];
    const firstOfRealm = arr.findIndex((a) => a.realm === realm);
    const idx = arr.findIndex((a) => a.realm === realm && a.accountId === accountId);
    if (idx > firstOfRealm) {
      const [moved] = arr.splice(idx, 1);
      if (moved) arr.splice(firstOfRealm, 0, moved);
      accounts.value = arr;
    }
    await persist();
  }

  /** Follow a server/client switch: activate that realm's preferred account
   *  (the first one in the current card order when none was promoted — the
   *  order follows the user's drags). No-op when the realm has no bound
   *  account or the right one is already active. Returns the account
   *  switched to, if any. */
  async function autoSwitchRealm(realm: string): Promise<AccountProfile | null> {
    if (pendingLoad) await pendingLoad;
    const target = preferredAccount.value(realm);
    if (!target) return null;
    if (activeRealm.value === target.realm && activeAccountId.value === target.accountId) {
      return null;
    }
    await setActive(target.realm, target.accountId);
    return target;
  }

  return {
    accounts,
    activeRealm,
    activeAccountId,
    preferredByRealm,
    activeAccount,
    preferredAccount,
    loading,
    load,
    addAccount,
    removeAccount,
    setActive,
    setPreferred,
    reorderAccounts,
    autoSwitchRealm,
  };
});
