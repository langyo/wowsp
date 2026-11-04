import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type SessionSnapshot } from "@/api";

/**
 * Rust session hub mirror — the "what is running / who is playing" state the
 * backend owns and broadcasts (`wowsp://session-changed`, commands/session.rs).
 *
 * Every window runs its own copy of this store (Pinia state never crosses a
 * webview boundary); the Rust hub is what keeps them coherent. The main
 * window additionally FOLLOWS the playing identity (see AppShell's watcher):
 * when a battle roster identifies the logged-in account, the account store's
 * active selection switches to it — realm-keyed auto-switching alone cannot
 * tell same-realm alts apart.
 *
 * Browser dev has no Rust hub: the fetch fails, the snapshot stays null, and
 * every consumer falls back to its local-only view (the gameStatus poll +
 * account store), which is exactly the pre-hub behavior.
 */
export const useSessionStore = defineStore("session", () => {
  const snapshot = ref<SessionSnapshot | null>(null);
  let started = false;
  let unlisten: (() => void) | null = null;
  /** Subscription epoch: a stop()→start() race must orphan the FIRST
   *  handshake (the started flag alone cannot — start() resets it before
   *  the first listener resolves, and a rejecting straggler would null the
   *  slot and orphan the live listener; crash.ts uses the same pattern). */
  let epoch = 0;

  /** Fetch once (boot / retry). */
  async function refresh() {
    try {
      snapshot.value = await api.getSessionState();
    } catch {
      // No Rust hub (browser dev) — consumers fall back to local state.
    }
  }

  /** Start the event subscription (idempotent; called on window mount). */
  function start() {
    if (started) return;
    started = true;
    const mine = ++epoch;
    void (async () => {
      try {
        const off = (await api.listenSessionChanged?.((s) => {
          snapshot.value = s;
        })) ?? null;
        // stop() (or a newer start()) raced the handshake — release now.
        if (mine !== epoch) {
          off?.();
          return;
        }
        unlisten = off;
      } catch {
        if (mine === epoch) unlisten = null;
      }
    })();
    void refresh();
  }

  /** Stop the subscription (window unmount). */
  function stop() {
    epoch += 1;
    unlisten?.();
    unlisten = null;
    started = false;
  }

  /** The resolved display player (playing identity when identified, else the
   *  active selection) — null while the hub is unavailable or nothing
   *  resolves. */
  const display = computed(() => snapshot.value?.display ?? null);
  const process = computed(() => snapshot.value?.process ?? null);

  return { snapshot, display, process, start, stop, refresh };
});
