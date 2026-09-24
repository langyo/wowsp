/**
 * Live-battle page (/live, desktop app only). Extracted from the old
 * ReplayView live pane: while the game runs it watches the replays folder
 * (a fresh .wowsreplay = battle over → SETTLING) and polls
 * tempArenaInfo.json every 3s so LiveBattlePanel's roster stays fresh; the
 * panel itself renders the LIVE/settling pill, the battle clock, the mode
 * pill and the map name in its own head — this page only adds the page
 * title and the full-height body around it.
 *
 * While the game is off (and no roster lingers) the body shows the
 * LiveIdleGuide two-step onboarding instead of the panel. The phone app
 * build has no local game install to watch, so it renders a static
 * placeholder and mounts none of the watchers (the nav link is hidden there
 * too — this is belt-and-braces for direct URLs).
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { api } from "@/api";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import LiveBattlePanel from "@/features/replay/LiveBattlePanel";
import LiveIdleGuide from "@/features/replay/LiveIdleGuide";
import { useBattleClock } from "@/features/replay/useBattleClock";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useOverlayStore } from "@/stores/overlay";
import { t } from "@/i18n";
import { isMobileApp } from "@/utils/platform";
import { modeKey } from "@/utils/modeColors";
import { replaysDir } from "@/utils/mapNames";
import "./LiveView.scss";

/** Hard end-of-battle fallback (see LiveView's battleCap watcher): PvP
 *  modes end at 20 min, everything else (co-op / operations / training
 *  rooms, which legitimately run long) at 30 min — matching the Rust
 *  overlay window's ARENA_FRESHNESS_SECS. */
const PVP_BATTLE_CAP_SECS = 20 * 60;
const PVE_BATTLE_CAP_SECS = 30 * 60;

export default defineComponent({
  name: "LiveView",
  setup() {
    if (isMobileApp()) {
      return () => (
        <main class="live-view">
          <div class="live-view__placeholder">{t("replay.live.notStarted")}</div>
        </main>
      );
    }

    const gd = useGameDetect();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const overlay = useOverlayStore();

    const activePath = computed(() => gd.config.activeInstall?.path ?? "");

    /** The realm to query live-roster stats against. Prefer the client
     *  install's realm, then the bound account's realm, else the default. */
    const realm = computed(
      () =>
        gd.config.activeInstall?.realm ??
        accounts.activeAccount?.realm ??
        accounts.activeRealm ??
        "asia",
    );

    /** Live battle clock (from tempArenaInfo's dateTime) — feeds the
     *  battle-duration cap below; the visible clock rides the panel. */
    const liveClock = useBattleClock(() => overlay.arenaInfo?.dateTime ?? null);

    /** Battle lifecycle: while the game runs, watch the replays folder —
     *  the game writes the .wowsreplay file when the battle ENDS, so a new
     *  file is the direct "match over" signal. On detection: flip to
     *  SETTLING (结算中 — stats screen, replay not yet final). When the
     *  game process exits, return to idle. A NEXT battle's roster (fresh
     *  tempArenaInfo dateTime) re-arms the battle phase — without this the
     *  settling pill would stick for every battle after the first in one
     *  game session. */
    const livePhase = ref<"idle" | "battle" | "settling">("idle");
    let baselineFiles: Set<string> | null = null;
    async function snapshotReplayDir(): Promise<Set<string> | null> {
      const dir = activePath.value ? replaysDir(activePath.value) : undefined;
      try {
        const files = await api.listReplays(dir);
        return new Set(files);
      } catch {
        return null;
      }
    }
    /** Arm the battle phase for a running game: flip to "battle" and
     *  snapshot the replay-dir baseline. Shared by the running-transition
     *  watcher and onMounted — opening /live after the battle already
     *  started must land in the same state a mid-page game start would. */
    async function armBattlePhase() {
      livePhase.value = "battle";
      baselineFiles = await snapshotReplayDir();
    }
    watch(
      () => gameStatus.process.running,
      async (running) => {
        if (running) {
          await armBattlePhase();
        } else {
          livePhase.value = "idle";
          baselineFiles = null;
        }
      },
    );
    watch(
      () => overlay.arenaInfo?.dateTime ?? null,
      (stamp, prev) => {
        if (stamp != null && stamp !== prev && gameStatus.process.running) {
          void armBattlePhase();
        }
      },
    );

    /** Hard end-of-battle fallback. A mid-battle quit writes no .wowsreplay
     *  (the settling watcher never fires) and the game deletes
     *  tempArenaInfo.json — the poll then flags the battle ended and the
     *  roster is retained on purpose, so the cap only guards a battle that
     *  is still LIVE (roster present, not ended, page in the battle phase):
     *  past the cap the roster is force-cleared until the next arena-info
     *  event repopulates it. Declared after the lifecycle block above —
     *  its getter reads `livePhase`, and `watch` evaluates the getter
     *  synchronously. */
    const battleCapHit = computed(() => {
      if (livePhase.value !== "battle" || overlay.battleEnded) return false;
      const a = overlay.arenaInfo;
      const elapsed = liveClock.elapsed.value;
      if (!a || elapsed == null) return false;
      const key = modeKey(a.matchGroup, a.scenario, null, a.botCount ?? 0);
      const pvp =
        key === "pvp" ||
        key === "ranked" ||
        key === "clan" ||
        key === "brawl" ||
        key === "squad" ||
        key === "armsrace";
      return elapsed >= (pvp ? PVP_BATTLE_CAP_SECS : PVE_BATTLE_CAP_SECS);
    });
    watch(battleCapHit, (hit) => {
      if (hit) overlay.clearArenaInfo();
    });
    let endPoll: number | null = null;
    watch(
      livePhase,
      (ph) => {
        if (ph === "battle") {
          if (endPoll === null) {
            endPoll = window.setInterval(async () => {
              if (baselineFiles == null) {
                baselineFiles = await snapshotReplayDir();
                return;
              }
              const now = await snapshotReplayDir();
              if (!now) return;
              const fresh = [...now].some((f) => !baselineFiles!.has(f));
              if (fresh) {
                livePhase.value = "settling";
              } else {
                baselineFiles = now;
              }
            }, 3000);
          }
        } else if (endPoll !== null) {
          clearInterval(endPoll);
          endPoll = null;
        }
      },
      { immediate: true },
    );

    // While the page is open, poll the game's tempArenaInfo.json so the
    // roster refreshes as players load in / the battle ends (the game
    // DELETES the file at battle end — an absent read flags the battle
    // ended and keeps the last roster on screen).
    let arenaTimer: number | null = null;
    onMounted(async () => {
      await gd.detect();
      // The watcher above only sees running→true transitions while this page
      // is mounted — a game that started BEFORE /live opened never fires it.
      // Seed the phase directly so the SETTLING pill can show mid-battle.
      if (gameStatus.process.running) {
        await armBattlePhase();
      }
      void overlay.refreshArenaInfo();
      arenaTimer = window.setInterval(() => void overlay.refreshArenaInfo(), 3000);
    });
    onBeforeUnmount(() => {
      if (endPoll !== null) clearInterval(endPoll);
      if (arenaTimer !== null) clearInterval(arenaTimer);
    });

    /** Panel body: mount it while the game runs or a roster exists. With
     *  neither there is nothing live to watch — show the placeholder. A
     *  finished battle keeps its roster in the store (battleEnded), so the
     *  panel stays up with the "ended" badge instead of blanking. */
    const battleLive = computed(
      () => gameStatus.process.running || overlay.arenaInfo != null,
    );

    return () => (
      <main class="live-view">
        <header class="live-view__head">
          <h2 class="live-view__title">{t("nav.live")}</h2>
        </header>
        <div class="live-view__body">
          {battleLive.value ? (
            <LiveBattlePanel
              arena={overlay.arenaInfo}
              settling={livePhase.value === "settling"}
              ended={overlay.battleEnded}
              realm={realm.value}
            />
          ) : (
            <LiveIdleGuide />
          )}
        </div>
      </main>
    );
  },
});
