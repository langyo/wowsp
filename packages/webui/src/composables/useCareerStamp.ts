import { computed, ref, watch, type ComputedRef } from "vue";

import type { PlayerStats } from "@/api";
import { lookupClanWinrate } from "@/utils/clanWinrate";
import { careerStamp, type CareerStamp } from "@/utils/winrate";

/**
 * Career verdict stamp with the hidden-profile clan gate, shared by the
 * stats card and the water-table share shots.
 *
 * The 过街老鼠 stamp waits for the player's clan winrate: a clan beating
 * RAT_CLAN_WINRATE_MAX excuses the hidden profile. `clanWinrate` is a
 * tri-state ref — undefined = verdict in flight, number | null = resolved
 * (null = the lookup failed → fail-open stamp) — and a generation guard
 * ensures only the lookup fired for the LATEST (clanId, realm) pair may
 * write the ref back: a fast string of lookups must not let a stale
 * response win.
 */
export function useCareerStamp(
  stats: () => PlayerStats | null,
): ComputedRef<CareerStamp | null> {
  const clanWinrate = ref<number | null | undefined>(undefined);
  let gen = 0;
  // Same watch shape the card used before the extraction: it re-fires on
  // every stats refresh (new stats object), which also RETRIES a failed
  // clan lookup — the verdict is uncached, so a transient failure must not
  // pin the fail-open stamp for the life of the view.
  watch(
    () => {
      const s = stats();
      return s ? ([s.clanId, s.realm] as const) : null;
    },
    (pair) => {
      const g = ++gen;
      const clanId = pair?.[0] ?? null;
      if (clanId == null) {
        // No clan to query — a terminal "no verdict needed" state, so a
        // clanless hidden profile stamps at once instead of waiting.
        clanWinrate.value = null;
        return;
      }
      clanWinrate.value = undefined;
      void lookupClanWinrate(pair![1], clanId).then((wr) => {
        if (g !== gen) return;
        clanWinrate.value = wr;
      });
    },
    { immediate: true },
  );
  return computed(() => {
    const s = stats();
    if (!s) return null;
    // A hidden profile with a clan holds its stamp until the clan verdict
    // lands (undefined) — the gate must never flash 老鼠 first and retract
    // it a beat later; clanless hidden profiles stamp immediately.
    if (s.hidden && s.clanId != null && clanWinrate.value === undefined) return null;
    return careerStamp(s.pr, s.battles, s.winrate, s.hidden, clanWinrate.value);
  });
}
