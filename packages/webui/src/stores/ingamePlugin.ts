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
 *
 * Lifecycle ops (install/update/uninstall) delegate to the pluginUpdates
 * store's shared orchestration — one busy table and one freshness
 * fan-out across every surface — so a probe updated here clears the
 * sidebar's update badge, and the sidebar's batch pass spins this card
 * and flips its status the moment the probe step lands. `busy` reads
 * that shared table instead of tracking its own ops.
 *
 * Safe mode (mod hub): quarantining `res_mods` deliberately makes the
 * probe report installed=false — the live tree really carries no plugin.
 * `safeMode` carries that context so the surfaces replace the install
 * offer with the recovery question instead of offering an install the
 * backend has to refuse as an English sentence. `repairSafeMode` is the
 * single shared "turn mods back on + repair the plugin" flow behind both
 * the boot prompt window and the live status card; its pre-checks mirror
 * the mod hub's localized guard refusals (safe mode, running client).
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { api } from "@/api";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginUpdatesStore, type PluginItemOp } from "@/stores/pluginUpdates";
import { sameGamePath } from "@/utils/gamePath";
import { guardRefusalKey } from "@/utils/refusalKey";
import { isKnownRealm } from "@/utils/realms";

export const useIngamePluginStore = defineStore("ingamePlugin", () => {
  const installed = ref(false);
  /** Installed but not the bytes this app ships (older build / hand-edited)
   *  — the UI offers a one-click update. */
  const outdated = ref(false);
  /** Null once probed; a failed probe (older shell, no install) stays null
   *  so consumers treat the plugin as absent rather than unknown. */
  const probed = ref(false);
  /** The install's `res_mods` is quarantined by the mod hub's safe mode —
   *  `installed` is false BY DESIGN then (the live tree has no plugin), so
   *  this flag is what tells a quarantine apart from a genuinely missing
   *  plugin. Older shells omit the field; `=== true` reads them as off. */
  const safeMode = ref(false);
  /** The probe itself rides a safe-mode twin — quarantined, not gone: it
   *  comes back the moment safe mode lifts, so the surfaces word the
   *  recovery as a rename, not a reinstall. Older shells omit the field
   *  (`=== true` reads them as false). */
  const quarantined = ref(false);
  /** Discussions thread backing the mod-hub page (for the page link). */
  const discussion = ref<number | null>(null);

  const config = useConfigStore();
  const pluginUpdates = usePluginUpdatesStore();
  const gameRoot = computed(
    () => config.activeInstall?.path ?? "",
  );

  /** Derived from the shared busy table: the probe is busy while ANY
   *  surface runs a lifecycle op on it, this store's own callers
   *  included. */
  const busy = computed<PluginItemOp | null>(() => pluginUpdates.probeBusy);
  let refreshSeq = 0;
  let statusRoot = "";

  function clearStatus() {
    installed.value = false;
    outdated.value = false;
    probed.value = false;
    safeMode.value = false;
    quarantined.value = false;
    discussion.value = null;
  }

  async function refresh() {
    const seq = ++refreshSeq;
    const root = gameRoot.value;
    if (root !== statusRoot) {
      statusRoot = root;
      clearStatus();
    }
    if (!root) {
      clearStatus();
      return;
    }
    try {
      const status = await api.ingamePluginStatus(root);
      if (seq !== refreshSeq || root !== gameRoot.value) return;
      installed.value = status.installed;
      outdated.value = status.outdated === true;
      // Absent from older shells — `=== true` is the only read that keeps
      // an undefined payload from flashing the safe-mode variant.
      safeMode.value = status.safeMode === true;
      quarantined.value = status.quarantined === true;
      discussion.value = status.discussion;
      probed.value = true;
    } catch {
      if (seq !== refreshSeq || root !== gameRoot.value) return;
      clearStatus();
    }
  }

  /** One-click install: writes the PnFMods bridge into the active install
   *  (backend refuses while the game runs). Delegates to the shared
   *  orchestration — busy table + freshness fan-out included — and keeps
   *  the caller contract: null on success, else the localized-error
   *  string for the toast. */
  async function install(): Promise<string | null> {
    return pluginUpdates.runProbe(gameRoot.value, "install");
  }

  /** One-click update — install overwrites in place, so this is install
   *  with update-flavored busy state (the card shows its own spinner). */
  async function update(): Promise<string | null> {
    return pluginUpdates.runProbe(gameRoot.value, "update");
  }

  async function uninstall(): Promise<string | null> {
    return pluginUpdates.runProbe(gameRoot.value, "uninstall");
  }

  /** Whether any running client belongs to `root` — the mod hub's
   *  multi-instance rule without its toast. A running process whose folder
   *  the backend could not resolve blocks conservatively (the old blanket
   *  behavior); a client running from a DIFFERENT install never blocks
   *  work on the selected one. */
  function targetClientRunning(root: string): boolean {
    const roots = useGameStatusStore().processes
      .filter((p) => p.running)
      .map((p) => p.matchedInstall?.path ?? null);
    if (roots.length === 0) return false;
    return roots.some((r) => r == null || sameGamePath(root, r));
  }

  /** Safe-mode recovery — the single shared "turn mods back on and repair
   *  the in-game plugin" flow behind the boot prompt's safe-mode variant
   *  and the live status card's repair button. Returns null on success,
   *  else a localized i18n key (or the raw backend sentence for a setter
   *  rejection) for the caller's toast, the same key-or-raw contract the
   *  lifecycle ops use. Known guard sentences are mapped through
   *  guardRefusalKey: a stale game-status snapshot can let the backend's
   *  "is running from" refusal through the pre-check.
   *
   *  The quarantine rename and the repair write both live in the game
   *  tree, so a running client is refused up front with the localized
   *  sentence instead of letting the backend's English guard reach a
   *  toast. The post-repair re-probe is awaited so the caller can rely on
   *  a refreshed snapshot even when the install half failed: the restore
   *  rename did happen, and the surfaces must stop offering the safe-mode
   *  recovery they no longer need. */
  async function repairSafeMode(): Promise<string | null> {
    const root = gameRoot.value;
    if (!root || busy.value) return "common.game.offline";
    if (targetClientRunning(root)) return "resources.gameRunningBlock";
    try {
      await api.modHubSetSafeMode(root, false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Defensive fallback: the pre-check above normally catches a running
      // client, but a stale snapshot can let the backend's English guard
      // sentence through — map the two known guards so the caller's toast
      // still renders localized, and surface everything else verbatim.
      return guardRefusalKey(msg) ?? msg;
    }
    const err = await pluginUpdates.runProbe(root, "install");
    await refresh();
    return err;
  }

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

  function clearIdentity() {
    if (identityExpiry) clearTimeout(identityExpiry);
    identityExpiry = null;
    identityAt.value = 0;
    identityBattle = "";
    selfRealm.value = "";
    playerRealms.value = {};
  }

  /** Fold one telemetry payload's identity block in. Stale or older-probe
   *  payloads (no identity fields) leave the state untouched; `self` and
   *  `identity` gate independently (the SELF latch can fail an early walk
   *  while the per-name map is fully valid, and vice versa); a new battle
   *  id resets both realm sources so the previous battle cannot bleed
   *  into the next one's routing. */
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
      selfRealm.value = "";
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

  // Status and telemetry belong to the selected install. Retire them in
  // the same tick as its root changes, before consumers use the new root.
  watch(gameRoot, () => {
    clearIdentity();
    void refresh();
  }, { immediate: true, flush: "sync" });

  const state = computed<"absent" | "outdated" | "installed">(() => {
    if (!installed.value) return "absent";
    return outdated.value ? "outdated" : "installed";
  });

  return {
    installed,
    outdated,
    probed,
    safeMode,
    quarantined,
    discussion,
    busy,
    state,
    gameRoot,
    refresh,
    install,
    update,
    uninstall,
    repairSafeMode,
    applyTelemetryIdentity,
    playerRealms,
    liveSelfRealm,
  };
});
