/** Account online badge store (账号列表「疑似在线」标记): one ~90s poll
 *  over the bound accounts while the window is visible, mapping the
 *  backend's per-account last_battle_time onto suspect flags.
 *
 *  The WG public API has no per-player presence: the flag means "a battle
 *  finished within the recent window, the account is probably still
 *  around" — never a guarantee. The threshold is a UI constant so the
 *  tooltip copy (account.suspectOnlineHint) and the window stay in one
 *  place; the sidebar row and the account manager cards both read it. */
import { ref, watch } from "vue";
import { defineStore } from "pinia";

import { api } from "@/api";
import { useAccountStore } from "@/stores/account";

/** Poll cadence. Visible ticks only — a hidden window neither needs the
 *  badge fresh nor should it spend WG-API budget. */
export const ONLINE_POLL_INTERVAL_MS = 90_000;

/** A battle FINISHED within this window ⇒ the account was played moments
 *  ago and its player is probably still around (in port or queuing): the
 *  疑似在线 badge. WG bumps last_battle_time at battle END only; 20 min
 *  covers the longest battles + result-upload lag + a little loitering. */
export const RECENT_BATTLE_WINDOW_MS = 20 * 60_000;

function onlineKey(realm: string, accountId: number): string {
  return realm + ":" + accountId;
}

export const useAccountOnlineStore = defineStore("accountOnline", () => {
  /** `${realm}:${accountId}` → the flag was positive on the last poll. */
  const suspect = ref<Record<string, boolean>>({});
  /** Unix ms of the last applied poll (tests + future "checked x ago"). */
  const lastPolledAt = ref(0);

  let polling = false;
  let inFlight = false;
  /** Newest-poll-wins guard: a slow earlier answer must never overwrite a
   *  fresher one (same shape as the markers store's fetchSeq). */
  let seq = 0;

  /** One poll: send every bound account, apply the flags atomically. A
   *  rejected poll keeps the previous map (the badge is positive-only
   *  evidence; a transient upstream hiccup leaves it stale for one round
   *  instead of blinking everything off). */
  async function pollOnce(): Promise<void> {
    if (inFlight) return;
    const accounts = useAccountStore().accounts;
    if (accounts.length === 0) return;
    inFlight = true;
    const mine = ++seq;
    try {
      const statuses = await api.accountOnlineCheck(
        accounts.map((a) => ({ accountId: a.accountId, nickname: a.nickname, realm: a.realm })),
      );
      if (mine !== seq) return;
      const now = Date.now();
      const next: Record<string, boolean> = {};
      for (const s of statuses) {
        if (
          s.lastBattleTime != null &&
          now - s.lastBattleTime * 1000 <= RECENT_BATTLE_WINDOW_MS
        ) {
          next[onlineKey(s.realm, s.accountId)] = true;
        }
      }
      suspect.value = next;
      lastPolledAt.value = now;
    } catch {
      // Transient upstream failure — keep the previous flags.
    } finally {
      inFlight = false;
    }
  }

  /** Start the poll loop once per app run (idempotent). The account list
   *  is re-read every tick, so binds/removes need no extra wiring; a fresh
   *  bind can still call pollOnce() for an immediate answer. */
  function ensurePolling(): void {
    if (polling) return;
    polling = true;
    void pollOnce();
    watch(
      () => useAccountStore().accounts,
      () => void pollOnce(),
      { deep: true },
    );
    window.setInterval(() => {
      if (document.hidden) return;
      void pollOnce();
    }, ONLINE_POLL_INTERVAL_MS);
  }

  /** The badge read: only accounts the backend could resolve (id-carrying,
   *  a reachable realm, an exact CN search hit) can ever flag true. */
  function suspectOf(realm: string, accountId: number | null | undefined): boolean {
    if (accountId == null) return false;
    return suspect.value[onlineKey(realm, accountId)] ?? false;
  }

  return { suspect, lastPolledAt, ensurePolling, pollOnce, suspectOf };
});
