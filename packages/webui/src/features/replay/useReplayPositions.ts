import { ref, watch, type Ref } from "vue";
import { api, type ReplayMeta, type ReplayStream } from "@/api";

/** Bind packet decoding to a selection's lifetime. A path comparison alone
 * cannot distinguish A → B → A, and errors/finally need the same protection
 * as successful results. Vue invalidates the request on change and unmount. */
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
    onCleanup(() => { stale = true; });
    handlers.reset();
    error.value = null;
    loading.value = replay !== null;
    if (!replay) return;
    try {
      const stream = await api.readReplayPositions(replay.path);
      if (!stale) handlers.apply(stream, replay);
    } catch (e) {
      if (!stale) error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (!stale) loading.value = false;
    }
  }, { flush: "sync", immediate: true });
  return { loading, error };
}
