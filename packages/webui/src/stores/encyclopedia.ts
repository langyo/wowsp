import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type GameVersionInfo, type ShipInfo } from "@/api";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";

/** Ship encyclopedia store. Caches the full shipopedia in memory after the
 *  first load; the Rust layer handles disk caching + version invalidation.
 *  The `version` ref lets views show "Data from game vX.Y.Z".
 *
 *  Language: the data-language setting determines which WG API language code
 *  to use (zh-cn, zh-sg, zh-tw, en, ...). Switching realm or language
 *  triggers a re-load. */
export const useEncyclopediaStore = defineStore("encyclopedia", () => {
  const ships = ref<ShipInfo[]>([]);
  const version = ref<GameVersionInfo | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loadedRealm = ref<string | null>(null);
  const loadedLanguage = ref<string | null>(null);

  /** In-game nation order (matching the port tech-tree panel left-to-right). */
  const NATION_ORDER: Record<string, number> = {
    japan: 0, usa: 1, ussr: 2, germany: 3, uk: 4, france: 5,
    pan_asia: 6, italy: 7, netherlands: 8, commonwealth: 9,
    pan_america: 10, spain: 11, europe: 12,
  };

  /** Ships grouped by nation → for the nation filter dropdown. */
  const nations = computed(() => {
    const set = new Set<string>();
    for (const s of ships.value) if (s.nation) set.add(s.nation);
    return [...set].sort((a, b) => (NATION_ORDER[a] ?? 99) - (NATION_ORDER[b] ?? 99));
  });

  /** Ships grouped by type → for the type filter (BB/CA/DD/CV/SS). */
  const types = computed(() => {
    const set = new Set<string>();
    for (const s of ships.value) if (s.type) set.add(s.type);
    return [...set].sort();
  });

  /** Lookup map: shipId → ShipInfo (for back-filling names in stats).
   *  Includes ALL ships including bracketed event ships for replay resolution. */
  const byId = computed(() => {
    const m = new Map<number, ShipInfo>();
    for (const s of ships.value) m.set(s.shipId, s);
    return m;
  });

  /** Ships visible in the tech tree / ship list UI. Bracketed copy/event
   *  ships (e.g. "[TS] Yamato") are hidden but still present in `byId` for
   *  replay roster and name resolution. */
  const displayShips = computed(() =>
    ships.value.filter((s) => !/[\[\]]/.test(s.name)),
  );

  /** Whether a ship name contains square brackets (an event-limited copy). */
  function isEventShip(shipName: string): boolean {
    return /[\[\]]/.test(shipName);
  }

  /** Format a ship's display name. For event ships (names with square
   *  brackets), strips brackets and appends a localized "(Event Limited)"
   *  suffix so the user can see it's a limited-time variant. */
  function shipDisplayName(ship: ShipInfo): string {
    const raw = ship.name || "";
    if (!/[\[\]]/.test(raw)) return raw;
    const clean = raw.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
    return `${clean} (${t("ships.label.eventLimited")})`;
  }

  /** Load the full encyclopedia for a realm. Safe to call repeatedly — the
   *  Rust layer serves from disk cache when version+language hasn't changed. */
  async function load(realm: string, forceRefresh = false) {
    const lang = useLanguage().dataLanguage.value;
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

  return { ships, displayShips, version, loading, error, loadedRealm, loadedLanguage, nations, types, byId, isEventShip, shipDisplayName, load };
});
