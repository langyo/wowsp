/**
 * Game-install detection composable. Wraps the config store's `detect()` with
 * a one-shot trigger so the home view can show a loading state while the Rust
 * side scans the registry + Steam libraries.
 *
 * Detection principle lives in `packages/app/tauri/src/commands/game_detect.rs`.
 */
import { useConfigStore } from "@/stores/config";

export function useGameDetect() {
  const config = useConfigStore();
  return {
    installs: config.installs,
    active: config.activeInstall,
    detecting: config.detecting,
    detect: () => config.detect(),
    setManualPath: (path: string) => config.setManualPath(path),
  };
}
