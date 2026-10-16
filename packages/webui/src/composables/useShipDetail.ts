import { computed, ref, watch } from "vue";

import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useTrendsStore } from "@/stores/trends";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { basicsToShipInfo, loadShipsBasics } from "@/utils/shipsBasics";
import type { ShipInfo } from "@/api";

/**
 * Opens the ship detail modal from water-table (per-ship stats) contexts:
 * ship rows only carry a shipId + display name, so this resolves the
 * encyclopedia `ShipInfo`, degrading to a synthetic entry (offline DB
 * tier/type/nation + the stats-row name) when that realm's encyclopedia
 * hasn't loaded yet — and upgrading the opened ship in place once the load
 * lands, so specs/portraits appear without a reopen.
 */
export function useShipDetail() {
  const encyclopedia = useEncyclopediaStore();
  const trends = useTrendsStore();
  const config = useConfigStore();
  const gameStatus = useGameStatusStore();

  const selectedShip = ref<ShipInfo | null>(null);
  /** The open ship is a synthetic stand-in awaiting the encyclopedia load. */
  const syntheticOpen = ref(false);
  /** Realm whose encyclopedia the synthetic entry is waiting on. */
  const wantedRealm = ref<string | null>(null);
  /** One retry kick per open — a failed load must not loop. */
  let retryKicked = false;

  /** Armor/GameParams root — the configured install, falling back to the
   * running process's matched install (same unification as ShipsView). */
  const gameRoot = computed(
    () => config.activeInstall?.path ?? gameStatus.process.matchedInstall?.path ?? "",
  );

  function syntheticInfo(shipId: number, fallbackName: string): ShipInfo {
    const off = shipOfflineEntry(shipId);
    return {
      shipId,
      name: fallbackName || `#${shipId}`,
      tier: off?.tier ?? 0,
      type: off?.type ?? "",
      nation: off?.nation ?? "",
      isPremium: false,
      isSpecial: false,
      description: "",
      gameVersion: "",
      defaultProfile: null,
      images: { small: "", medium: "", large: "", contour: "" },
    };
  }

  function openShip(shipId: number, fallbackName: string, realm: string) {
    retryKicked = false;
    const info = encyclopedia.byId.get(shipId);
    if (info) {
      syntheticOpen.value = false;
      wantedRealm.value = null;
      selectedShip.value = info;
    } else {
      // Kick the encyclopedia for this realm (lookup view may never have
      // loaded it); the watch below upgrades the entry when it arrives.
      if (encyclopedia.loadedRealm !== realm && !encyclopedia.loading) {
        void encyclopedia.load(realm);
      }
      syntheticOpen.value = true;
      wantedRealm.value = realm;
      selectedShip.value = syntheticInfo(shipId, fallbackName);
      // The bundled ship-basics asset can upgrade the synthetic entry even
      // when the WG API never lands (offline / lite install): specs need a
      // real defaultProfile.
      void loadShipsBasics()
        .then((basics) => {
          const entry = basics.ships[String(shipId)];
          if (!entry || !syntheticOpen.value) return;
          const cur = selectedShip.value;
          if (!cur || cur.shipId !== shipId) return;
          // Keep the stats-row display name (already localized / tagged);
          // the bundle only contributes the real defaultProfile.
          selectedShip.value = { ...basicsToShipInfo(shipId, basics, entry), name: cur.name };
        })
        .catch(() => {});
    }
    // Preload community trend for the modal's "Server Trend" tab.
    void trends.loadCommunity(shipId);
  }

  function closeShip() {
    selectedShip.value = null;
    syntheticOpen.value = false;
    wantedRealm.value = null;
  }

  // Upgrade a synthetic entry in place once its realm's encyclopedia lands,
  // and re-kick the load once when the in-flight/landed encyclopedia turned
  // out to be for a different realm (so the entry isn't stranded forever).
  watch(
    () => [encyclopedia.byId, encyclopedia.loading, encyclopedia.loadedRealm] as const,
    ([byId]) => {
      const cur = selectedShip.value;
      if (!cur || !syntheticOpen.value) return;
      const info = byId.get(cur.shipId);
      if (info) {
        selectedShip.value = info;
        syntheticOpen.value = false;
        wantedRealm.value = null;
        return;
      }
      const wanted = wantedRealm.value;
      if (
        !encyclopedia.loading &&
        wanted != null &&
        encyclopedia.loadedRealm !== wanted &&
        !retryKicked
      ) {
        retryKicked = true;
        void encyclopedia.load(wanted);
      }
    },
  );

  return { selectedShip, openShip, closeShip, gameRoot };
}
