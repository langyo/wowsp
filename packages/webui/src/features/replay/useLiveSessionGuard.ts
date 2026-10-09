/**
 * Live-content session guard (main window, mounted from App): the /live
 * page deliberately RETAINS the last battle's roster and self-stats after
 * the battle ends or the game closes (post-battle review), but that
 * retention is only meaningful while the content still belongs to the
 * CURRENT client session. When the player closes the client and launches
 * a different one (another server's install, or a relaunch that logged a
 * different account in), the retained battle is stale: this guard watches
 * the client-session identity and clears the live stores the moment it
 * moves out from under the shown battle, so the page falls back to its
 * waiting state instead of presenting the previous session's numbers.
 *
 * Two signals, either alone suffices:
 *  - the running client's PID differs from the PID that produced the
 *    roster (client switch or relaunch — an account change necessarily
 *    relaunches the client, so this catches it in port, before any new
 *    battle writes a roster);
 *  - the session hub's playing identity moved between two DIFFERENT
 *    players (a re-observed login on the same process).
 *
 * A bare exit (client closed, nothing relaunched) intentionally clears
 * nothing — the review feature keeps the last battle on screen.
 */
import { watch } from "vue";

import type { PlayingAccount } from "@/api";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useLiveSelfStore } from "@/stores/liveSelf";
import { useOverlayStore } from "@/stores/overlay";
import { useSessionStore } from "@/stores/session";

/** Stable key for a playing identity: realm + nickname. The account id is
 *  deliberately NOT part of the key — the plugin bridge upgrades an
 *  already-noted identity with its exact id mid-battle (nickname stays),
 *  which must not read as an account switch. */
function playingKey(p: PlayingAccount | null): string | null {
  return p ? `${p.realm}:${p.nickname}` : null;
}

export function useLiveSessionGuard() {
  const gameStatus = useGameStatusStore();
  const overlay = useOverlayStore();
  const liveSelf = useLiveSelfStore();
  const session = useSessionStore();

  function clearLiveContent() {
    overlay.clearArenaInfo();
    liveSelf.reset();
  }

  /** PID of the client session that wrote the roster currently on screen
   *  (null when the roster arrived before any client was ever seen — a
   *  crash leftover on a fresh app, stale by definition once anything
   *  runs). Undefined until a roster was ever seen. */
  let rosterPid: number | null | undefined;
  /** The last PID seen running. Backs the latch when a roster lands while
   *  the process poll momentarily reports offline (a failed poll during a
   *  battle's first seconds): latching the remembered PID instead of null
   *  keeps the poll's recovery from reading as a session switch. */
  let lastRunningPid: number | null = null;

  // Latch the writer session whenever a roster LANDS (the battle stamp —
  // the 3 s poll replaces the arenaInfo object itself mid-battle, so the
  // dateTime is the only change signal that means "a battle wrote this").
  watch(
    () => overlay.arenaInfo?.dateTime ?? null,
    (stamp) => {
      if (stamp == null) return;
      rosterPid = gameStatus.process.running
        ? gameStatus.process.pid ?? null
        : lastRunningPid;
    },
  );

  // Client switch / relaunch: a running session that is not the one the
  // shown roster came from invalidates the content. Checked only while a
  // client runs — the offline stretches keep the review feature intact,
  // and a transient poll failure (an offline blip) recovers with the same
  // PID and clears nothing. On multi-client machines the pid follows the
  // PREFERRED instance (the gameStatus store's derived process), so the
  // same rule covers the preferred slot changing hands: the roster's
  // writer exiting while another client takes over reads as "a different
  // client is live now".
  watch(
    () => [gameStatus.process.running, gameStatus.process.pid ?? null] as const,
    ([running, pid]) => {
      if (running && pid != null) lastRunningPid = pid;
      if (!running || overlay.arenaInfo == null || rosterPid === undefined) return;
      if (rosterPid !== pid) clearLiveContent();
    },
  );

  // Account switch on the same process: the hub re-identifies the player
  // from a new roster — two different consecutive identities invalidate
  // the content even though the PID signal never moved.
  watch(
    () => playingKey(session.snapshot?.playing ?? null),
    (key, prev) => {
      if (key != null && prev != null && key !== prev) clearLiveContent();
    },
  );
}
