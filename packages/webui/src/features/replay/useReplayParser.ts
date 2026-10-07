/**
 * Replay-parsing composable. Wraps the replay store so the ReplayView can
 * trigger a header parse and hand the result to the holographic map.
 *
 * Uses `storeToRefs` so the returned `list`/`external`/`current`/`loading`/
 * `error` stay as refs (callers use `.value` in render functions). The action
 * methods (`refreshAll`/`open`/`clear`/`addExternal`/`removeExternal`) are
 * returned as plain functions — Pinia actions are not refs. The rail always
 * reads the ALL-clients scan; a caller that needs one explicit root goes
 * through `api.listReplaysMeta(dir)` (TacticsView's map inventory does).
 *
 * The actual 8-byte-magic + JSON-block extraction lives in
 * `packages/app/tauri/src/commands/replay.rs`.
 */
import { storeToRefs } from "pinia";
import { useReplayStore } from "@/stores/replay";

export function useReplayParser() {
  const store = useReplayStore();
  const { list, external, current, loading, error } = storeToRefs(store);
  return {
    list,
    external,
    current,
    loading,
    error,
    refreshAll: () => store.refreshAll(),
    open: (path: string) => store.open(path),
    addExternal: (paths: string[]) => store.addExternal(paths),
    removeExternal: (path: string) => store.removeExternal(path),
    clear: () => store.clear(),
  };
}
