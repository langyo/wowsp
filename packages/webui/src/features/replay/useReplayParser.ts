/**
 * Replay-parsing composable. Wraps the replay store so the ReplayView can
 * trigger a header parse and hand the result to the holographic map.
 *
 * The actual 8-byte-magic + JSON-block extraction lives in
 * `packages/app/tauri/src/commands/replay.rs`.
 */
import { useReplayStore } from "@/stores/replay";

export function useReplayParser() {
  const store = useReplayStore();
  return {
    list: store.list,
    current: store.current,
    loading: store.loading,
    error: store.error,
    refreshList: (dir?: string) => store.refreshList(dir),
    open: (path: string) => store.open(path),
    clear: () => store.clear(),
  };
}
