/**
 * Live-battle page (/live, desktop app only). Extracted from the old
 * ReplayView live pane: while the game runs it watches the replays folder
 * (a fresh .wowsreplay = battle over → SETTLING) and polls
 * tempArenaInfo.json every 3s so LiveBattlePanel's roster stays fresh; the
 * panel renders the LIVE/settling pill, the battle clock, the mode pill and
 * the map name in its own head — this page only wraps the full-height body
 * around it (no page title of its own: the panel's heading IS the title).
 *
 * While the game is off (and no roster lingers) the body shows the
 * LiveIdleGuide two-step onboarding instead of the panel. The phone app
 * build has no local game install to watch, so it renders a static
 * placeholder and mounts none of the watchers (the nav link is hidden there
 * too — this is belt-and-braces for direct URLs).
 */
import { X } from "@lucide/vue";
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { api } from "@/api";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import LiveBattlePanel from "@/features/replay/LiveBattlePanel";
import LiveIdleGuide from "@/features/replay/LiveIdleGuide";
import PostBattlePanel from "@/features/replay/PostBattlePanel";
import { isOperationBattle } from "@/utils/modeColors";
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

    /** The folder live battle data comes from: while a client is actually
     *  running, ITS replays folder is the one receiving tempArenaInfo.json
     *  and the settling .wowsreplay — on multi-install machines that can
     *  differ from the selected install, so the running process's folder
     *  wins (mirrors the backend's live-order resolution). */
    const liveRoot = computed(
      () => gameStatus.process.matchedInstall?.path ?? activePath.value,
    );

    /** The realm to query live-roster stats against. Prefer the RUNNING
     *  client's realm (the roster belongs to it), then the selected
     *  install's, then the bound account's, else the default. */
    const realm = computed(
      () =>
        gameStatus.process.matchedInstall?.realm ??
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
    /** The fresh .wowsreplay whose appearance flipped the phase to settling
     *  (newest when several landed at once — names lead with the capture
     *  timestamp, so a plain lexicographic sort is chronological). Feeds the
     *  post-battle window's BattleResults read. */
    const freshReplay = ref<string | null>(null);
    let baselineFiles: Set<string> | null = null;
    async function snapshotReplayDir(): Promise<Set<string> | null> {
      const dir = liveRoot.value ? replaysDir(liveRoot.value) : undefined;
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
      freshReplay.value = null;
      // A new battle invalidates the previous one's post-battle window.
      postBattleOpen.value = false;
      postBattleFailed.value = false;
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
        // Keep freshReplay after the game exits: the ended roster stays up
        // and the post-battle window must stay reachable off the SAME file.
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
      const key = modeKey(
        a.matchGroup,
        a.scenario,
        null,
        a.botCount ?? 0,
        a.scriptedUnitCount ?? 0,
      );
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
              const fresh = [...now]
                .filter((f) => !baselineFiles!.has(f))
                .sort()
                .at(-1);
              if (fresh != null) {
                freshReplay.value = fresh;
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

    // ── Post-battle window (战后统计) ───────────────────────────────────
    // Opened from the panel head once the battle settles/ends: reads the
    // fresh replay's BattleResults payload (a full position parse — heavy,
    // hence the busy state) and mounts the SAME PostBattlePanel the replay
    // view's 结果 modal uses, dressed with the retained arena's mode/map.
    // While the game still sits on its results screen the file can lack the
    // settlement packet — that reads as "unavailable, retry shortly".
    const postBattleRaw = ref<string | null>(null);
    const postBattleOpen = ref(false);
    const postBattleBusy = ref(false);
    const postBattleFailed = ref(false);
    const arena = computed(() => overlay.arenaInfo);
    const postBattleOperation = computed(() =>
      isOperationBattle(
        arena.value?.matchGroup,
        arena.value?.scenario,
        arena.value?.eventType,
        arena.value?.vehicles.map((v) => v.name),
      ),
    );
    async function openPostBattle() {
      const path = freshReplay.value;
      if (!path || postBattleBusy.value) return;
      postBattleBusy.value = true;
      postBattleFailed.value = false;
      try {
        const stream = await api.readReplayPositions(path);
        if (stream.battleResults) {
          postBattleRaw.value = stream.battleResults;
          postBattleOpen.value = true;
        } else {
          postBattleFailed.value = true;
        }
      } catch {
        postBattleFailed.value = true;
      } finally {
        postBattleBusy.value = false;
      }
    }

    return () => (
      <main class="live-view">
        {/* No page-level header: the panel renders the page title itself
            ("实时对局" used to appear twice — the slim eyebrow here plus the
            panel's own heading), and the idle guide carries its own. */}
        <div class="live-view__body">
          {battleLive.value ? (
            <LiveBattlePanel
              arena={overlay.arenaInfo}
              settling={livePhase.value === "settling"}
              ended={overlay.battleEnded}
              realm={realm.value}
              onResults={freshReplay.value ? () => void openPostBattle() : undefined}
              resultsBusy={postBattleBusy.value}
              resultsFailed={postBattleFailed.value}
            />
          ) : (
            <LiveIdleGuide />
          )}
        </div>

        {/* Post-battle stats window — the same component the replay view's
            结果 modal mounts; the retained arena dresses its head pills. */}
        {postBattleOpen.value && postBattleRaw.value ? (
          <div class="live-view__modal" onClick={() => (postBattleOpen.value = false)}>
            <div class="live-view__modal-panel" onClick={(e) => e.stopPropagation()}>
              <div class="live-view__modal-head">
                <div class="live-view__modal-title">
                  <strong>{t("replay.live.postBattle")}</strong>
                </div>
                <button
                  class="live-view__modal-close"
                  onClick={() => (postBattleOpen.value = false)}
                  aria-label="Close"
                >
                  <X size={14} />
                </button>
              </div>
              <div class="live-view__modal-body">
                <PostBattlePanel
                  raw={postBattleRaw.value}
                  head={{
                    matchGroup: arena.value?.matchGroup ?? null,
                    scenario: arena.value?.scenario ?? null,
                    eventType: arena.value?.eventType ?? null,
                    botCount: arena.value?.botCount ?? null,
                    scriptedUnitCount: arena.value?.scriptedUnitCount ?? null,
                    mapName: arena.value?.mapName ?? null,
                  }}
                  operation={postBattleOperation.value}
                  onClose={() => (postBattleOpen.value = false)}
                />
              </div>
            </div>
          </div>
        ) : null}
      </main>
    );
  },
});
