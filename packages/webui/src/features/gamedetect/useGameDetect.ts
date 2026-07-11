/**
 * Game-install detection composable. Returns the live config store + a detect()
 * trigger. Callers access store state directly (pinia auto-unwraps refs in
 * reactive contexts), so no `.value` in render functions.
 *
 * Detection principle lives in `packages/app/tauri/src/commands/game_detect.rs`.
 */
import { useConfigStore } from "@/stores/config";

export function useGameDetect() {
  const config = useConfigStore();
  return {
    config,
    detect: () => config.detect(),
    setManualPath: (path: string) => config.setManualPath(path),
  };
}
