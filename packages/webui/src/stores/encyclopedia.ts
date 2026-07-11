import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type GameVersionInfo, type ShipInfo } from "@/api";

/** Ship encyclopedia store. Caches the full shipopedia in memory after the
 *  first load; the Rust layer handles disk caching + version invalidation.
 *  The `version` ref lets views show "Data from game vX.Y.Z". */
export const useEncyclopediaStore = defineStore("encyclopedia", () => {
  const ships = ref<ShipInfo[]>([]);
  const version = ref<GameVersionInfo | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loadedRealm = ref<string | null>(null);

  /** Ships grouped by nation → for the nation filter dropdown. */
  const nations = computed(() => {
    const set = new Set<string>();
    for (const s of ships.value) if (s.nation) set.add(s.nation);
    return [...set].sort();
  });

  /** Ships grouped by type → for the type filter (BB/CA/DD/CV/SS). */
  const types = computed(() => {
    const set = new Set<string>();
    for (const s of ships.value) if (s.type) set.add(s.type);
    return [...set].sort();
  });

  /** Lookup map: shipId → ShipInfo (for back-filling names in stats). */
  const byId = computed(() => {
    const m = new Map<number, ShipInfo>();
    for (const s of ships.value) m.set(s.shipId, s);
    return m;
  });

  /** Load the full encyclopedia for a realm. Safe to call repeatedly — the
   *  Rust layer serves from disk cache when the version hasn't changed. */
  async function load(realm: string, forceRefresh = false) {
    if (!forceRefresh && loadedRealm.value === realm && ships.value.length > 0) return;
    loading.value = true;
    error.value = null;
    try {
      // Fetch version first (drives cache key on the Rust side).
      version.value = await api.getGameVersion();
      ships.value = await api.getShipEncyclopedia(realm, forceRefresh);
      loadedRealm.value = realm;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  return { ships, version, loading, error, loadedRealm, nations, types, byId, load };
});
