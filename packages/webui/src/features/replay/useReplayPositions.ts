import { ref, watch, type Ref } from "vue";
import { api, type ReplayMeta, type ReplayStream } from "@/api";

/** Upper bound on ONE packed replay-stream read. A settled IPC promise is
 *  the only event that ever clears the results pill's spinner (and the pill
 *  is the post-battle window's only entry point), yet neither
 *  `api.readReplayPositions` nor the Tauri invoke under it has a timeout:
 *  a stalled `ipc.localhost` round trip — the wedge class
 *  `utils/ipcGuard.ts` probes for at startup — would leave the spinner
 *  turning forever. The Rust decode of a 20-minute match is ~0.5 s and the
 *  wire is a few MB, so this budget only ever fires on a stuck channel; on
 *  expiry the view surfaces an error and stays usable instead of freezing
 *  in the loading state. */
export const REPLAY_STREAM_READ_TIMEOUT_MS = 30_000;

/** Bind packet decoding to a selection's lifetime. A path comparison alone
 *  cannot distinguish A → B → A, and errors/finally need the same protection
 *  as successful results. Vue invalidates the request on change and unmount. */
export function useReplayPositions(
  current: Ref<ReplayMeta | null>,
  handlers: {
    reset: () => void;
    apply: (stream: ReplayStream, replay: ReplayMeta) => void;
  },
) {
  const loading = ref(false);
  const error = ref<string | null>(null);
  watch(current, async (replay, _previous, onCleanup) => {
    let stale = false;
    /** Set by the watchdog: the read is still pending but the view already
     *  reported the stall, so its late result must not publish. */
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => {
      stale = true;
      if (timer !== undefined) clearTimeout(timer);
    });
    handlers.reset();
    error.value = null;
    loading.value = replay !== null;
    if (!replay) return;
    // The IPC call cannot be aborted (Tauri has no per-invoke cancel), so the
    // watchdog settles the VISIBLE state instead of the await: the spinner
    // (and the post-battle window's only entry point) must never depend on a
    // channel that may have stalled forever.
    timer = setTimeout(() => {
      if (stale) return;
      timedOut = true;
      error.value = `replay packet stream read timed out after ${REPLAY_STREAM_READ_TIMEOUT_MS / 1000}s`;
      loading.value = false;
    }, REPLAY_STREAM_READ_TIMEOUT_MS);
    try {
      const stream = await api.readReplayPositions(replay.path);
      if (!stale && !timedOut) handlers.apply(stream, replay);
    } catch (e) {
      if (!stale && !timedOut) error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!stale && !timedOut) loading.value = false;
    }
  }, { flush: "sync", immediate: true });
  return { loading, error };
}
