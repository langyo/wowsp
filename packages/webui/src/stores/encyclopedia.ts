import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { api, type GameVersionInfo, type ShipInfo } from "@/api";
import { useAccountStore } from "@/stores/account";
import { useLanguage, wgApiLanguage } from "@/i18n/useLanguage";
import { shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";

/** Replace API names with localized names from the offline game-file DB
 *  (ship_names.json, extracted from res/texts/<lang> gettext catalogs).
 *  The WG API serves the same harmonized simplified Chinese on every realm,
 *  so the 亚服/国服 distinction the user picks cannot be sourced from it —
 *  the game client files are the only realm-distinct source. Ships missing
 *  from the offline DB keep their API name. Event-ship bracket tags
 *  ("[TS] Yamato") are carried over unchanged so `displayShips` filtering
 *  and `isEventShip` keep working. */
function localizeShipNames(list: ShipInfo[], lang: string): ShipInfo[] {
  return list.map((s) => {
    const localized = shipNameFromOfflineDb(s.shipId, lang);
    if (!localized || localized === s.name) return s;
    const tags = s.name.match(/\[[^\]]*\]/g)?.join(" ") ?? "";
    return { ...s, name: tags ? `${localized} ${tags}` : localized };
  });
}

/** Ship encyclopedia store. Caches the full shipopedia in memory after the
 *  first load; the Rust layer handles disk caching + version invalidation.
 *  The `version` ref lets views show "Data from game vX.Y.Z".
 *
 *  Language: the data-language setting determines which WG API language code
 *  to use (zh-cn, zh-tw, en, ...). Switching realm or language triggers a
 *  re-load. Display names are then overlaid from the offline game-file DB
 *  (ship_names.json) — the WG API only carries one simplified Chinese (the
 *  harmonized CN translation) on every realm, so the 亚服简体 original names
 *  can only come from the game client files. */
export const useEncyclopediaStore = defineStore("encyclopedia", () => {
  const ships = ref<ShipInfo[]>([]);
  const version = ref<GameVersionInfo | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loadedRealm = ref<string | null>(null);
  const loadedLanguage = ref<string | null>(null);

  /** Monotonic generation for loads. Switching language/realm while a fetch
   *  is in flight bumps it; the stale response is discarded on arrival. The
   *  previous `if (loading) return` silently DROPPED the switch instead, so
   *  the UI kept showing the previous language's names under the new setting. */
  let loadSeq = 0;

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
    ships.value.filter((s) => !/[[]]/.test(s.name)),
  );

  /** Whether a ship name contains square brackets (an event-limited copy). */
  function isEventShip(shipName: string): boolean {
    return /[[]]/.test(shipName);
  }

  /** Format a ship's display name. For event ships (names with square
   *  brackets), strips brackets and appends a localized "(Event Limited)"
   *  suffix so the user can see it's a limited-time variant. */
  function shipDisplayName(ship: ShipInfo): string {
    const raw = ship.name || "";
    if (!/[[]]/.test(raw)) return raw;
    const clean = raw.replace(/[[]]/g, "").replace(/\s+/g, " ").trim();
    return `${clean} (${t("ships.label.eventLimited")})`;
  }

  /** Load the full encyclopedia for a realm. Safe to call repeatedly — the
   *  Rust layer serves from disk cache when version+language hasn't changed.
   *  On failure the existing ships list is preserved so the UI doesn't go blank.
   *  A language/realm switch supersedes any in-flight load (generation
   *  counter) — the stale response is discarded instead of clobbering the
   *  freshly selected language.
   *  INVALID_LANGUAGE errors from the WG API are silently retried with English. */
  async function load(realm: string, forceRefresh = false) {
    const lang = useLanguage().dataLanguage.value;
    // The WG API takes lowercase codes ("zh-cn"); the store keys caches by
    // the canonical lang-loc ("zh-CN").
    const apiLang = wgApiLanguage(lang);
    if (!forceRefresh && loadedRealm.value === realm && loadedLanguage.value === lang && ships.value.length > 0) return;
    const seq = ++loadSeq;
    loading.value = true;
    error.value = null;
    try {
      const ver = await api.getGameVersion();
      const fresh = await api.getShipEncyclopedia(realm, forceRefresh, apiLang);
      if (seq !== loadSeq) return; // a newer realm/language load took over
      version.value = ver;
      ships.value = localizeShipNames(fresh, lang);
      loadedRealm.value = realm;
      loadedLanguage.value = lang;
    } catch (e) {
      if (seq !== loadSeq) return;
      const msg = (e as Error).message || String(e);
      // WG API returns INVALID_LANGUAGE for unsupported language codes — retry
      // silently with English so data is always available. loadedLanguage
      // stays as the user's preference to avoid a retry loop on every page visit.
      if (/INVALID_LANGUAGE/i.test(msg) && lang !== "en-US") {
        try {
          const ver = await api.getGameVersion();
          const fresh = await api.getShipEncyclopedia(realm, true, "en");
          if (seq !== loadSeq) return;
          version.value = ver;
          ships.value = localizeShipNames(fresh, lang);
          loadedRealm.value = realm;
          loadedLanguage.value = lang; // stay as user's preference
          console.warn("[encyclopedia] INVALID_LANGUAGE for %s, fell back to en", lang);
        } catch (e2) {
          error.value = ((e2 as Error).message || String(e2)).slice(0, 300);
        }
      } else {
        error.value = msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
      }
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  // Auto-reload when data-language setting or active realm changes.
  watch(
    () => [useLanguage().dataLanguage.value, useAccountStore().activeRealm] as const,
    ([lang, realm], [oldLang, oldRealm]) => {
      if (oldLang && (lang !== oldLang || realm !== oldRealm)) {
        load(realm, true);
      }
    },
  );

  return { ships, displayShips, version, loading, error, loadedRealm, loadedLanguage, nations, types, byId, isEventShip, shipDisplayName, load };
});
