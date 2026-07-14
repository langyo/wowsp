import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type GameVersionInfo, type ShipInfo } from "@/api";
import { resolveWgLanguage } from "@/i18n/useLanguage";

/** Ship encyclopedia store. Caches the full shipopedia in memory after the
 *  first load; the Rust layer handles disk caching + version invalidation.
 *  The `version` ref lets views show "Data from game vX.Y.Z".
 *
 *  Language: the encyclopedia is fetched in the current UI language (zhs →
 *  zh-hans, etc.), EXCEPT for CN realm which always uses zh-cn (unique ship
 *  names, e.g. IJN animals). Switching realm or language triggers a re-load. */
export const useEncyclopediaStore = defineStore("encyclopedia", () => {
  const ships = ref<ShipInfo[]>([]);
  const version = ref<GameVersionInfo | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loadedRealm = ref<string | null>(null);
  const loadedLanguage = ref<string | null>(null);

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

  /** Effective WG language code for game-asset (ship/captain) names. Uses the
   *  independent data-language setting (auto → derive from UI locale + realm,
   *  preserving the CN-server animal-name distinction) rather than the raw UI
   *  locale, so the user can decouple ship-name language from UI language. */
  function currentLanguage(): string {
    return resolveWgLanguage();
  }

  /** Load the full encyclopedia for a realm. Safe to call repeatedly — the
   *  Rust layer serves from disk cache when version+language hasn't changed. */
  async function load(realm: string, forceRefresh = false) {
    const lang = currentLanguage();
    if (!forceRefresh && loadedRealm.value === realm && loadedLanguage.value === lang && ships.value.length > 0) return;
    loading.value = true;
    error.value = null;
    try {
      version.value = await api.getGameVersion();
      ships.value = await api.getShipEncyclopedia(realm, forceRefresh, lang);
      loadedRealm.value = realm;
      loadedLanguage.value = lang;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  return { ships, version, loading, error, loadedRealm, loadedLanguage, nations, types, byId, load };
});
