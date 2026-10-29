/** The app's SHOWN player identity — ONE source of truth shared by the
 *  sidebar's account row and the phone-layout title-bar avatar button.
 *
 *  The player shown is the session hub's RESOLVED identity when the hub is
 *  reachable (it carries the actually-playing account — the battle
 *  roster's local player matched against the bound profiles, so same-realm
 *  alts are told apart — and even unregistered alts the store cannot
 *  represent), falling back to the store's active selection (browser dev /
 *  older shell, where the hub snapshot stays null).
 *
 *  The emblem (dog tag) feeds avatars through the shared stats store's
 *  cache — READ THROUGH it, never a second API call — hydrated cache-only
 *  (loadCached), same policy as the account cards. */
import { computed, watch, type ComputedRef } from "vue";

import type { PlayerStats, SessionPlayer } from "@/api";
import { useAccountStore } from "@/stores/account";
import { useSessionStore } from "@/stores/session";
import { useStatsStore } from "@/stores/stats";
import type { DogTag } from "@/api";

export interface ShownPlayer {
  shownPlayer: ComputedRef<SessionPlayer | null>;
  /** Cached stats for the shown player (emblem source); null when the
   *  account is unknown or its cache has not landed yet. */
  activeStats: ComputedRef<PlayerStats | null>;
  /** The shown player's dog-tag emblem, when the cache carries one. */
  dogTag: ComputedRef<DogTag | null>;
}

export function useShownPlayer(): ShownPlayer {
  const accounts = useAccountStore();
  const session = useSessionStore();
  const stats = useStatsStore();

  const shownPlayer = computed<SessionPlayer | null>(() => {
    if (session.display) return session.display;
    const a = accounts.activeAccount;
    return a
      ? {
          accountId: a.accountId,
          nickname: a.nickname,
          realm: a.realm,
          registered: true,
          playing: false,
        }
      : null;
  });

  const activeStats = computed<PlayerStats | null>(() => {
    const a = shownPlayer.value;
    return a?.accountId != null
      ? stats.cache.get(a.realm + "_" + a.accountId) ?? null
      : null;
  });

  // Warm the shared cache from disk so the emblem is there on cold start;
  // the computed above reacts when the map fills.
  watch(
    () => shownPlayer.value,
    async (a) => {
      if (a?.accountId != null) await stats.loadCached(a.realm, a.accountId);
    },
    { immediate: true },
  );

  const dogTag = computed<DogTag | null>(() => activeStats.value?.dogTag ?? null);

  return { shownPlayer, activeStats, dogTag };
}
