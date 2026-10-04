/**
 * In-game stats plugin (packages/ingame-plugin) presence + lifecycle for
 * the live-battle surfaces. One shared probe feeding three consumers:
 *
 * - LiveBattlePanel's status corner grades the telemetry source (plugin
 *   connected vs. degraded screen-capture inference),
 * - LiveBattlePanel's waiting state shows the plugin card status-only,
 * - LiveIdleGuide offers one-click install when absent, update when the
 *   installed bytes predate this app build (content-hash freshness — the
 *   in-game version string is pinned at 0.1.0 by owner decision), and
 *   uninstall when present, so a broken install can be reinstalled.
 *
 * Presence means the PnFMods bridge sits in the ACTIVE game install
 * (commands/ingame_plugin.rs); the probe re-runs whenever that selection
 * changes.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { api } from "@/api";
import { useConfigStore } from "@/stores/config";
import { isKnownRealm } from "@/utils/realms";

export const useIngamePluginStore = defineStore("ingamePlugin", () => {
  const installed = ref(false);
  /** Installed but not the bytes this app ships (older build / hand-edited)
   *  — the UI offers a one-click update. */
  const outdated = ref(false);
  /** Null once probed; a failed probe (older shell, no install) stays null
   *  so consumers treat the plugin as absent rather than unknown. */
  const probed = ref(false);
  /** Discussions thread backing the mod-hub page (for the page link). */
  const discussion = ref<number | null>(null);
  /** "install" | "uninstall" | "update" while a lifecycle command is in flight. */
  const busy = ref<"install" | "uninstall" | "update" | null>(null);

  const config = useConfigStore();
  const gameRoot = computed(
    () => config.activeInstall?.path ?? "",
  );

  async function refresh() {
    const root = gameRoot.value;
    if (!root) {
      installed.value = false;
      outdated.value = false;
      probed.value = false;
      return;
    }
    try {
      const status = await api.ingamePluginStatus(root);
      installed.value = status.installed;
      outdated.value = status.outdated === true;
      discussion.value = status.discussion;
      probed.value = true;
    } catch {
      installed.value = false;
      outdated.value = false;
      probed.value = false;
    }
  }

  /** One-click install: writes the PnFMods bridge into the active install
   *  (backend refuses while the game runs). Returns null on success, else
   *  the localized-error string for the caller to toast. */
  async function install(): Promise<string | null> {
    const root = gameRoot.value;
    if (!root || busy.value) return "common.game.offline";
    busy.value = "install";
    try {
      // Same PnFMods layout the probe installer writes (Main.py + the
      // 0-byte loader marker); the backend refuses while the game runs.
      await api.ingamePluginInstall(root);
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = null;
    }
  }

  /** One-click update — install overwrites in place, so this is install
   *  with update-flavored busy state (the card shows its own spinner). */
  async function update(): Promise<string | null> {
    const root = gameRoot.value;
    if (!root || busy.value) return "common.game.offline";
    busy.value = "update";
    try {
      await api.ingamePluginInstall(root);
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = null;
    }
  }

  async function uninstall(): Promise<string | null> {
    const root = gameRoot.value;
    if (!root || busy.value) return "common.game.offline";
    busy.value = "uninstall";
    try {
      await api.ingamePluginUninstall(root);
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = null;
    }
  }

  // The active install is the probe's identity — switching installs (or
  // first detection on cold start) re-probes.
  watch(gameRoot, () => void refresh(), { immediate: true });

  // ── Ground-truth identity off the probe's telemetry ──────────────────
  // The realm-reporting probe change adds `self` + `identity` to every
  // telemetry payload — the local player's cluster and a per-name
  // name→realm map straight off the game's own roster records. Consumers
  // use them to stop INFERRING the realm (install logs / kind fallbacks):
  // roster stats route each name to its reported cluster, and the live
  // surfaces prefer `liveSelfRealm` over every detection chain while the
  // stream is fresh.
  const selfRealm = ref("");
  const playerRealms = ref<Record<string, string>>({});
  /** Reactive so `liveSelfRealm` re-evaluates when the stamp moves. */
  const identityAt = ref(0);
  let identityBattle = "";
  // The expiry that makes the freshness window REAL: a computed reading
  // Date.now() never re-runs on its own, so a stream that simply stops
  // (battle over, game closed, /live unmounted) would pin its last realm
  // forever. Every payload re-arms this timer; when it fires the identity
  // lapses and every consumer falls back to its detection chain.
  let identityExpiry: ReturnType<typeof setTimeout> | null = null;

  /** Fold one telemetry payload's identity block in. Stale or older-probe
   *  payloads (no identity fields) leave the state untouched; `self` and
   *  `identity` gate independently (the SELF latch can fail an early walk
   *  while the per-name map is fully valid, and vice versa); a new battle
   *  id resets the per-name map so rows from the previous battle cannot
   *  bleed into the next one's routing. */
  function applyTelemetryIdentity(payload: {
    t?: number;
    battle?: string;
    self?: { name?: string; realm?: string };
    identity?: Record<string, { account_id?: number; realm?: string }>;
  }): void {
    if (!payload || !payload.t || Date.now() - payload.t > 30_000) return;
    const selfCode = (payload.self?.realm ?? "").trim().toLowerCase();
    const hasIdentity = !!payload.identity;
    if (!selfCode && !hasIdentity) return;
    if (payload.battle && payload.battle !== identityBattle) {
      identityBattle = payload.battle;
      playerRealms.value = {};
    }
    identityAt.value = Date.now();
    if (identityExpiry) clearTimeout(identityExpiry);
    identityExpiry = setTimeout(() => {
      identityExpiry = null;
      identityAt.value = 0;
      selfRealm.value = "";
      playerRealms.value = {};
    }, 35_000);
    if (isKnownRealm(selfCode)) selfRealm.value = selfCode;
    if (hasIdentity) {
      const map = { ...playerRealms.value };
      for (const [name, row] of Object.entries(payload.identity!)) {
        const realm = (row?.realm ?? "").trim().toLowerCase();
        if (isKnownRealm(realm)) map[name] = realm;
      }
      playerRealms.value = map;
    }
  }

  /** The local player's probe-reported realm while the identity is live
   *  (the expiry timer lapses it), else "" — consumers fall back to their
   *  detection chains. */
  const liveSelfRealm = computed(() =>
    identityAt.value > 0 ? selfRealm.value : "",
  );

  const state = computed<"absent" | "outdated" | "installed">(() => {
    if (!installed.value) return "absent";
    return outdated.value ? "outdated" : "installed";
  });

  return {
    installed,
    outdated,
    probed,
    discussion,
    busy,
    state,
    gameRoot,
    refresh,
    install,
    update,
    uninstall,
    applyTelemetryIdentity,
    playerRealms,
    liveSelfRealm,
  };
});
