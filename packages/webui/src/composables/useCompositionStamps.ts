import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from "vue";

import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useShipStatsStore } from "@/stores/shipStats";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { compositionStamps, type CompositionStamps } from "@/utils/winrate";

/** 空中小人 / 水下小人 for a viewed player, resolved from the shared per-ship
 *  cache — the same data the ship distribution table reads, so no extra
 *  fetch. An empty cache (per-ship stats not loaded for this player yet)
 *  simply yields no tags. */
export function useCompositionStamps(
  accountId: MaybeRefOrGetter<number | null | undefined>,
  realm: MaybeRefOrGetter<string | null | undefined>,
): ComputedRef<CompositionStamps> {
  const shipStats = useShipStatsStore();
  const encyclopedia = useEncyclopediaStore();

  return computed(() => {
    const id = toValue(accountId);
    const realmKey = toValue(realm);
    if (id == null || !realmKey) return { air: false, sub: false };
    const ships = shipStats.cache.get(`${realmKey}_${id}`) ?? [];
    /** Ship type: encyclopedia first, offline DB fallback. */
    const typeOf = (shipId: number) =>
      encyclopedia.byId.get(shipId)?.type ?? shipOfflineEntry(shipId)?.type;
    return compositionStamps(ships, typeOf);
  });
}
