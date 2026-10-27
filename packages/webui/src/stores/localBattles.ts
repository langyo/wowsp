/** Local replay battle-log store. Wraps `read_local_battle_log` with an
 *  in-memory per-account cache so the dashboard's date-range tabs can derive
 *  a REAL recent-battles view from the local replay files (the WG API only
 *  serves career totals).
 *
 *  Semantics:
 *    - one latest log per account (`realm_accountId`) plus the window it was
 *      loaded for — the view labels the summary from that window rather than
 *      re-deriving "now" from a clock that moved since the load;
 *    - same-window re-reads serve the decoded window cache instantly;
 *    - concurrent identical loads share ONE in-flight request;
 *    - a cold scan reports `pending` files (the backend's decode pool is
 *      bounded), so a load re-invokes until nothing is pending — capped at
 *      MAX_PENDING_ROUNDS so a wedged pool can never spin a request loop.
 *
 *  `force` (the refresh pill's path) bypasses the window cache. */
import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type LocalBattleLog } from "@/api";

/** Inclusive Unix-second window a log was loaded for. */
export interface LocalBattleWindow {
  fromSec: number;
  toSec: number;
}

/** Follow-up rounds a single load may run after the backend reported pending
 *  decode work. Cold scans typically settle within one extra round; the cap
 *  is the loop fence, not an expected budget. */
export const MAX_PENDING_ROUNDS = 5;

function accountKey(accountId: number, realm: string): string {
  return `${realm}_${accountId}`;
}

function windowKey(accountKey: string, fromSec: number, toSec: number): string {
  return `${accountKey}_${fromSec}_${toSec}`;
}

export const useLocalBattlesStore = defineStore("localBattles", () => {
  /** Latest decoded log per account — what the dashboard summary reads. */
  const cache = ref<Map<string, LocalBattleLog>>(new Map());
  /** The window each account's cached log was loaded for. */
  const windows = ref<Map<string, LocalBattleWindow>>(new Map());
  /** A load is in flight (any account/window) — drives no UI by itself; the
   *  fetching views keep their own busy flags. */
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** In-flight load per window key — a duplicate request joins it. */
  const inflight = new Map<string, Promise<LocalBattleLog>>();
  /** Decoded logs per window key — same-window re-reads are instant. */
  const windowCache = new Map<string, LocalBattleLog>();
  /** Latest request generation per window key — a superseded (forced)
   *  request must not clobber the window cache when it settles late. */
  const generations = new Map<string, number>();
  /** Monotonic request sequence per account — only the account's MOST
   *  RECENT load request may replace its current log/window, so a slow
   *  request for a range the user already switched away from can never
   *  overwrite the newer range's cache (which would make the dashboard
   *  drop the replay rows of the tab actually on screen). */
  const latestRequest = new Map<string, number>();
  let nextRequest = 0;
  let activeCalls = 0;

  /** Make the account's current log/window point at `log`. */
  function adopt(
    k: string,
    log: LocalBattleLog,
    fromSec: number,
    toSec: number,
  ): void {
    cache.value.set(k, log);
    windows.value.set(k, { fromSec, toSec });
  }

  /** One backend round-trip chain: the initial read plus pending follow-ups. */
  async function fetchWindow(
    accountId: number,
    realm: string,
    fromSec: number,
    toSec: number,
  ): Promise<LocalBattleLog> {
    let log = await api.readLocalBattleLog(accountId, realm, fromSec, toSec);
    for (let round = 0; round < MAX_PENDING_ROUNDS && log.pending > 0; round++) {
      log = await api.readLocalBattleLog(accountId, realm, fromSec, toSec);
    }
    return log;
  }

  /** Load the battle log for [fromSec, toSec]. Resolves instantly from the
   *  cache when the exact window was already decoded (unless `force`),
   *  otherwise fetches — deduping concurrent identical requests and
   *  following up while the backend reports pending work. Rejections land in
   *  `error` and re-throw so callers can keep their fallback view. */
  async function load(
    accountId: number,
    realm: string,
    fromSec: number,
    toSec: number,
    opts: { force?: boolean } = {},
  ): Promise<LocalBattleLog> {
    const k = accountKey(accountId, realm);
    const wk = windowKey(k, fromSec, toSec);
    if (!opts.force) {
      const cached = windowCache.get(wk);
      if (cached) {
        // A cache hit is the user's new current window (switching back to a
        // range already decoded) — it claims the account's latest request,
        // retiring any still-running load for another window.
        latestRequest.set(k, ++nextRequest);
        adopt(k, cached, fromSec, toSec);
        return cached;
      }
      const running = inflight.get(wk);
      if (running) {
        // Joining a running request still makes THIS call the account's
        // latest intent: if the user switched away and came back while the
        // range was still decoding, the shared result must claim the
        // current log/window when it settles — otherwise the tab would
        // keep showing the previous range's fallback after the load.
        const joinSeq = ++nextRequest;
        latestRequest.set(k, joinSeq);
        void running.then(
          (log) => {
            if (latestRequest.get(k) === joinSeq) adopt(k, log, fromSec, toSec);
          },
          (e: unknown) => {
            if (latestRequest.get(k) === joinSeq) error.value = (e as Error).message;
          },
        );
        return running;
      }
    }
    const requestSeq = ++nextRequest;
    latestRequest.set(k, requestSeq);
    const generation = (generations.get(wk) ?? 0) + 1;
    generations.set(wk, generation);
    const request = (async () => {
      activeCalls++;
      loading.value = true;
      error.value = null;
      try {
        const log = await fetchWindow(accountId, realm, fromSec, toSec);
        // A newer request for the same window superseded this one — its
        // result is the current truth for that window's cache.
        if (generations.get(wk) === generation) windowCache.set(wk, log);
        // Only the account's latest REQUEST may claim the current
        // log/window: a slower load of a range the user already left must
        // not replace the tab actually on screen (see latestRequest).
        if (latestRequest.get(k) === requestSeq) adopt(k, log, fromSec, toSec);
        return log;
      } catch (e) {
        // A stale request's failure is not the current view's error.
        if (latestRequest.get(k) === requestSeq) error.value = (e as Error).message;
        throw e;
      } finally {
        if (generations.get(wk) === generation) inflight.delete(wk);
        if (--activeCalls === 0) loading.value = false;
      }
    })();
    inflight.set(wk, request);
    return request;
  }

  /** The account's latest decoded log (null until a load succeeded). */
  function logFor(accountId: number, realm: string): LocalBattleLog | null {
    return cache.value.get(accountKey(accountId, realm)) ?? null;
  }

  /** The window `logFor` was loaded for (null until a load succeeded). */
  function windowFor(accountId: number, realm: string): LocalBattleWindow | null {
    return windows.value.get(accountKey(accountId, realm)) ?? null;
  }

  return {
    cache,
    windows,
    loading,
    error,
    load,
    logFor,
    windowFor,
  };
});
