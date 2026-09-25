import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type GameInstall } from "@/api";
import { normalizeGamePath, sameGamePath } from "@/utils/gamePath";

/**
 * Holds the detected game install + user settings (realm, replay dir).
 * The game-install detection runs once on app start; users can re-run it or
 * pin a manual path. The active install (which client the replay list + stats
 * read from) is persisted by the shell as `game-config.toml` through the
 * typed get/set commands (migrated from the pre-TOML `game-config.json`,
 * sanitized on every read/write — see commands/game_config.rs) so switching
 * clients survives a restart.
 */

/** localStorage key for install paths the user removed from the list —
 *  re-running detection must not resurrect rows the user deleted, so removed
 *  auto-detected installs are ignored by path (manual re-adding clears the
 *  ignore). Not the shell's game-config.toml: this is presentation-level
 *  state owned by the webui. */
const IGNORED_GAME_PATHS_KEY = "wowsp-ignored-game-paths";

function loadIgnoredGamePaths(): string[] {
  try {
    const raw = localStorage.getItem(IGNORED_GAME_PATHS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveIgnoredGamePaths(paths: string[]) {
  try {
    localStorage.setItem(IGNORED_GAME_PATHS_KEY, JSON.stringify(paths));
  } catch {
    // storage unavailable (private mode) — the ignore just won't survive
  }
}

/** Belt-and-braces dedupe on top of the Rust scan (commands/game_detect.rs
 *  `dedupe_installs`): one row per normalized folder, keeping the first
 *  occurrence. Guards the mock backend and any future source drift. */
function dedupeInstalls(installs: GameInstall[]): GameInstall[] {
  const seen = new Set<string>();
  return installs.filter((i) => {
    const key = normalizeGamePath(i.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const useConfigStore = defineStore("config", () => {
  const installs = ref<GameInstall[]>([]);
  const activeInstall = ref<GameInstall | null>(null);
  const detecting = ref(false);

  // Paths removed by the user (see IGNORED_GAME_PATHS_KEY); `detect()` filters
  // detected installs against this list.
  let ignoredPaths = loadIgnoredGamePaths();

  // Path remembered from the previous session (restored by `load()`, consumed
  // by `detect()` so a previously-selected client survives a rescan).
  let rememberedPath: string | null = null;

  /** Load the persisted active-install path from AppData. Call once on app
   *  startup BEFORE `detect()`; `detect()` then re-resolves it against the
   *  fresh scan and keeps it if the install still exists. */
  async function load() {
    try {
      const cfg = await api.getGameConfig();
      rememberedPath = cfg?.activePath ?? null;
    } catch {
      // command unavailable (mock backend) — nothing remembered
    }
  }

  async function detect() {
    detecting.value = true;
    try {
      installs.value = dedupeInstalls(await api.detectGameInstall()).filter(
        (i) => !ignoredPaths.some((p) => sameGamePath(p, i.path)),
      );
      // Prefer the remembered client (from last session) if it's still among
      // the detected installs; otherwise keep the current selection if valid;
      // otherwise fall back to the first detected install.
      const pickByPath = (path: string | null) =>
        path ? installs.value.find((i) => sameGamePath(i.path, path)) ?? null : null;
      let resolved: GameInstall | null =
        pickByPath(rememberedPath) ??
        pickByPath(activeInstall.value?.path ?? null) ??
        installs.value[0] ??
        null;
      // A remembered manual path that auto-detection can't see (custom
      // folder, unusual Steam library layout) must survive the rescan —
      // re-validate it through the backend instead of dropping the user's
      // choice, which would otherwise re-trigger the first-launch prompt
      // on every start. A path the user removed is NOT resurrected here:
      // the ignore list wins over a stale persisted activePath.
      if (
        !resolved &&
        rememberedPath &&
        !ignoredPaths.some((p) => sameGamePath(p, rememberedPath))
      ) {
        try {
          resolved = await api.setGamePath(rememberedPath);
        } catch {
          resolved = null; // the folder is truly gone — prompt again
        }
      }
      activeInstall.value = resolved;
      // A remembered manual path that auto-detection can't see must still be
      // selectable in the sidebar's server dropdown.
      if (resolved && !installs.value.some((i) => sameGamePath(i.path, resolved.path))) {
        installs.value = [...installs.value, resolved];
      }
      rememberedPath = null; // consumed
      await persist();
    } finally {
      detecting.value = false;
    }
  }

  /** Switch the active client. Used by the replay-view client selector and
   *  the settings 游戏路径 table. Persists the choice so it survives a
   *  restart. */
  async function selectInstall(path: string) {
    const found = installs.value.find((i) => sameGamePath(i.path, path));
    if (found) {
      activeInstall.value = found;
      await persist();
    }
  }

  /** Validate a folder through the backend and pin it as the active install
   *  (manual paths live in `installs` too). Returns the resolved install so
   *  callers can react to its realm. */
  async function setManualPath(path: string): Promise<GameInstall> {
    const resolved = await api.setGamePath(path);
    activeInstall.value = resolved;
    // Re-adding a folder the user previously removed lifts the ignore — an
    // explicit pin always wins over the removal list.
    ignoredPaths = ignoredPaths.filter((p) => !sameGamePath(p, resolved.path));
    saveIgnoredGamePaths(ignoredPaths);
    // Keep the manual install listed alongside the detected ones (settings
    // 游戏路径 table + replay-view selector).
    if (!installs.value.some((i) => sameGamePath(i.path, resolved.path))) {
      installs.value = [...installs.value, resolved];
    }
    await persist();
    return resolved;
  }

  /** Drop an install from the list (settings 游戏路径 table's per-row
   *  delete). Auto-detected rows are remembered as ignored so re-running
   *  detection doesn't resurrect them; removing the active install switches
   *  to the first remaining one (null when the list empties, which re-arms
   *  the first-launch prompt). */
  async function removeInstall(path: string) {
    const target = installs.value.find((i) => sameGamePath(i.path, path));
    installs.value = installs.value.filter((i) => !sameGamePath(i.path, path));
    if (target) {
      ignoredPaths = [...ignoredPaths, target.path];
      saveIgnoredGamePaths(ignoredPaths);
    }
    if (activeInstall.value && sameGamePath(activeInstall.value.path, path)) {
      activeInstall.value = installs.value[0] ?? null;
      await persist();
    }
  }

  /** Persist the active install's path (just the path — `detect()` re-resolves
   *  kind/realm on the next scan, so we don't risk storing a stale kind). */
  async function persist() {
    try {
      await api.setGameConfig(activeInstall.value?.path ?? null);
    } catch {
      // best-effort — don't fail the action if persistence is unavailable
    }
  }

  return {
    installs,
    activeInstall,
    detecting,
    detect,
    load,
    selectInstall,
    setManualPath,
    removeInstall,
  };
});
