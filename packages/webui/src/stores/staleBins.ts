/**
 * Global stale-bin awareness — the data behind the sidebar's bottom-left
 * game-upgrade prompt. Older `bin/<version>/res_mods` leftovers mean the
 * game updated while mods (and possibly the in-game probe plugin) were
 * installed: the mod-hub page has long surfaced them with its migration
 * banner, but the user who never opens that page never learns their mods
 * went dark — so this store polls the SAME backend command for the
 * ACTIVE install and feeds a footer prompt that deep-links into the
 * migration wizard.
 *
 * The Resources page keeps its own (richer) scan — it also covers the
 * running client's folder when no install is selected — and pushes every
 * result here via `adopt`, so the prompt clears the moment a migration
 * finishes instead of waiting out the poll.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { api, type StaleBinInfo } from "@/api";
import { useConfigStore } from "@/stores/config";
import { sameGamePath } from "@/utils/gamePath";

/** Re-scan cadence — the game only upgrades while the app runs, and the
 *  scan is one directory walk per stranded bin, so a slow poll is plenty. */
const POLL_MS = 60_000;

export const useStaleBinsStore = defineStore("staleBins", () => {
  const config = useConfigStore();
  const gameRoot = computed(() => config.activeInstall?.path ?? "");
  const bins = ref<StaleBinInfo[]>([]);

  /** Any stranded bin at all — the prompt's visibility. */
  const hasStale = computed(() => bins.value.length > 0);
  /** Stranded mod files across all stale bins — the prompt's counter. */
  const totalFiles = computed(() => bins.value.reduce((n, b) => n + b.fileCount, 0));
  /** The in-game probe plugin is among the stranded files — the prompt
   *  then says the migration carries it too. */
  const probeStranded = computed(() => bins.value.some((b) => b.probeInstalled));

  async function refresh() {
    const root = gameRoot.value;
    if (!root) {
      bins.value = [];
      return;
    }
    try {
      const list = await api.modHubStaleVersions(root);
      // The active install may have switched while the RPC was in flight —
      // only the still-active root's answer may land.
      if (sameGamePath(root, gameRoot.value)) bins.value = list;
    } catch {
      // Older shell / transient failure: keep the last known state — a
      // flaky poll must not flicker the prompt away mid-decision.
    }
  }

  /** Adopt a list another surface (the Resources page's scan) just
   *  fetched for the same install — same RPC, no duplicate round trip. */
  function adopt(root: string, list: StaleBinInfo[]) {
    if (root && gameRoot.value && sameGamePath(root, gameRoot.value)) {
      bins.value = list;
    }
  }

  // The active install is the prompt's identity. A root switch drops the
  // previous install's data at once (a failed first probe must not show
  // another install's prompt); within one root, a failed poll keeps the
  // last good state so a flaky call can't flicker the prompt away. The
  // slow poll catches upgrades that land while the app is open.
  watch(
    gameRoot,
    (_root, prev) => {
      if (prev !== undefined) bins.value = [];
      void refresh();
    },
    { immediate: true },
  );
  window.setInterval(() => void refresh(), POLL_MS);

  return {
    gameRoot,
    bins,
    hasStale,
    totalFiles,
    probeStranded,
    refresh,
    adopt,
  };
});
