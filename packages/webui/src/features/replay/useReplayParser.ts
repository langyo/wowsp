/**
 * Replay-parsing composable. Wraps the replay store so the ReplayView can
 * trigger a header parse and hand the result to the holographic map.
 *
 * Uses `storeToRefs` so the returned `list`/`current`/`loading`/`error` stay
 * as refs (callers use `.value` in render functions). The action methods
 * (`refreshList`/`open`/`clear`) are returned as plain functions — Pinia
 * actions are not refs.
 *
 * The actual 8-byte-magic + JSON-block extraction lives in
 * `packages/app/tauri/src/commands/replay.rs`.
 */
import { storeToRefs } from "pinia";
import { useReplayStore } from "@/stores/replay";

export function useReplayParser() {
  const store = useReplayStore();
  const { list, current, loading, error } = storeToRefs(store);
  return {
    list,
    current,
    loading,
    error,
    refreshList: (dir?: string) => store.refreshList(dir),
    open: (path: string) => store.open(path),
    clear: () => store.clear(),
  };
}
