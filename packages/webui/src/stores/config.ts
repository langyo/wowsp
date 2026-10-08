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

/** localStorage key for the user's custom install row order (settings 游戏路径
 *  drag handles). The shell only persists the ACTIVE path (game-config.toml),
 *  so the list order is presentation-level state owned by the webui (same
 *  policy as IGNORED_GAME_PATHS_KEY) and re-applied to every scan. */
const GAME_PATH_ORDER_KEY = "wowsp-game-path-order";

function loadGamePathOrder(): string[] {
  try {
    const raw = localStorage.getItem(GAME_PATH_ORDER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveGamePathOrder(paths: string[]) {
  try {
    localStorage.setItem(GAME_PATH_ORDER_KEY, JSON.stringify(paths));
  } catch {
    // storage unavailable (private mode) — the order just won't survive
  }
}

/** Order a freshly scanned list by the remembered custom order: rows with a
 *  saved position come first in that order (stable sort), rows the scan has
 *  found since — never dragged — compare equal and keep scan order (stable
 *  sort) after them. The comparator never mixes ranks with a sentinel, so
 *  there is no NaN case for the engine's sort to mishandle. */
function applySavedOrder(installs: GameInstall[], order: string[]): GameInstall[] {
  const rank = new Map(order.map((p, idx) => [normalizeGamePath(p), idx]));
  return [...installs].sort((a, b) => {
    const ra = rank.get(normalizeGamePath(a.path));
    const rb = rank.get(normalizeGamePath(b.path));
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1;
    if (rb != null) return 1;
    return 0;
  });
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
  // detected installs against this list. A ref so the data surfaces that read
  // the Rust scan — which knows nothing of this presentation-level ignore —
  // can react too: the scan keeps finding an ignored client's replays, and a
  // row whose client is not in the list must not pretend to be one (it could
  // never be picked in the client menus, and filtering for it would answer an
  // empty set).
  const ignoredPaths = ref<string[]>(loadIgnoredGamePaths());

  // Custom row order dragged by the user (see GAME_PATH_ORDER_KEY); applied
  // to the list on every scan.
  let gamePathOrder = loadGamePathOrder();

  // Extra replay folders pinned by the user (游玩时间 view's 录像来源
  // manager) — persisted shell-side in game-config.toml and scanned
  // alongside each client's own replays folder. Seeded by `load()`;
  // add/remove go through the typed backend commands (they validate
  // overlap against the live scan roots), never a raw set.
  const replayDirs = ref<string[]>([]);

  // Path remembered from the previous session (restored by `load()`, consumed
  // by `detect()` so a previously-selected client survives a rescan).
  let rememberedPath: string | null = null;
  let scanSequence = 0;
  let selectionSequence = 0;
  let pendingSave: Promise<unknown> = Promise.resolve();

  function invalidateScan() {
    scanSequence++;
    detecting.value = false;
  }

  function beginSelection() {
    rememberedPath = null;
    invalidateScan();
    return ++selectionSequence;
  }

  /** Keep state changes and their writes in order. Explicit actions publish
   *  only after saving, so failed choices never become a rollback baseline. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const save = pendingSave.then(operation);
    pendingSave = save.catch(() => undefined);
    return save;
  }

  /** Load the persisted active-install path from AppData. Call once on app
   *  startup BEFORE `detect()`; `detect()` then re-resolves it against the
   *  fresh scan and keeps it if the install still exists. */
  async function load() {
    const selection = selectionSequence;
    try {
      const cfg = await api.getGameConfig();
      if (selection === selectionSequence) rememberedPath = cfg?.activePath ?? null;
      replayDirs.value = cfg?.replayDirs ?? [];
    } catch {
      // command unavailable (mock backend) — nothing remembered
    }
  }

  async function detect() {
    const sequence = ++scanSequence;
    detecting.value = true;
    try {
      const scanned = dedupeInstalls(await api.detectGameInstall()).filter(
        (i) => !ignoredPaths.value.some((p) => sameGamePath(p, i.path)),
      );
      if (sequence !== scanSequence) return;
      // Validate the user's choice BEFORE falling back to an auto-detected
      // client. Manual installs need not appear in the automatic scan.
      const preferredPath = rememberedPath ?? activeInstall.value?.path ?? null;
      let resolved: GameInstall | null =
        scanned.find((i) => sameGamePath(i.path, preferredPath)) ?? null;
      // A remembered manual path that auto-detection can't see (custom
      // folder, unusual Steam library layout) must survive the rescan —
      // re-validate it through the backend instead of dropping the user's
      // choice, which would otherwise re-trigger the first-launch prompt
      // on every start. A path the user removed is NOT resurrected here:
      // the ignore list wins over a stale persisted activePath.
      if (
        !resolved &&
        preferredPath &&
        !ignoredPaths.value.some((p) => sameGamePath(p, preferredPath))
      ) {
        try {
          resolved = await api.setGamePath(preferredPath);
        } catch {
          resolved = null; // the folder is truly gone — prompt again
        }
      }
      if (sequence !== scanSequence) return;
      resolved ??= scanned[0] ?? null;
      // A remembered manual path that auto-detection can't see must still be
      // selectable in the sidebar's server dropdown.
      if (resolved && !scanned.some((i) => sameGamePath(i.path, resolved.path))) {
        scanned.push(resolved);
      }
      const selection = resolved;
      await enqueue(async () => {
        if (sequence !== scanSequence) return;
        // Background detection remains usable if persistence is unavailable.
        await api.setGameConfig(selection?.path ?? null).catch(() => undefined);
        activeInstall.value = selection;
        installs.value = applySavedOrder(scanned, gamePathOrder);
        rememberedPath = null; // consumed
      });
    } finally {
      if (sequence === scanSequence) detecting.value = false;
    }
  }

  /** Switch the active client. Used by the replay-view client selector and
   *  the settings 游戏路径 table. Persists the choice so it survives a
   *  restart. */
  async function selectInstall(path: string) {
    // Capture the row the user clicked. A scan already saving ahead of this
    // action may replace the list before the queued selection can run.
    const found = installs.value.find((i) => sameGamePath(i.path, path));
    if (!found) return;
    beginSelection();
    await enqueue(async () => {
      await api.setGameConfig(found.path);
      invalidateScan();
      activeInstall.value = found;
      ignoredPaths.value = ignoredPaths.value.filter((p) => !sameGamePath(p, found.path));
      saveIgnoredGamePaths(ignoredPaths.value);
      if (!installs.value.some((i) => sameGamePath(i.path, found.path))) {
        installs.value = [...installs.value, found];
      }
    });
  }

  /** Validate a folder through the backend and pin it as the active install
   *  (manual paths live in `installs` too). Returns the resolved install so
   *  callers can react to its realm, or null when a newer choice supersedes it. */
  async function setManualPath(path: string): Promise<GameInstall | null> {
    const selection = beginSelection();
    let resolved: GameInstall;
    try {
      resolved = await api.setGamePath(path);
    } catch (error) {
      if (selection !== selectionSequence) return null;
      throw error;
    }
    return enqueue(async () => {
      // Another explicit choice superseded this folder validation. Callers
      // can quietly leave the newer choice in place without an error toast.
      if (selection !== selectionSequence) return null;
      await api.setGameConfig(resolved.path);
      invalidateScan();
      activeInstall.value = resolved;
      // Re-adding a removed folder lifts the ignore only after it saves.
      ignoredPaths.value = ignoredPaths.value.filter((p) => !sameGamePath(p, resolved.path));
      saveIgnoredGamePaths(ignoredPaths.value);
      if (!installs.value.some((i) => sameGamePath(i.path, resolved.path))) {
        installs.value = [...installs.value, resolved];
      }
      return resolved;
    });
  }

  /** Drop an install from the list (settings 游戏路径 table's per-row
   *  delete). Auto-detected rows are remembered as ignored so re-running
   *  detection doesn't resurrect them; removing the active install switches
   *  to the first remaining one (null when the list empties, which re-arms
   *  the first-launch prompt). */
  async function removeInstall(path: string) {
    const target = installs.value.find((i) => sameGamePath(i.path, path));
    beginSelection();
    await enqueue(async () => {
      const remaining = installs.value.filter((i) => !sameGamePath(i.path, path));
      if (activeInstall.value && sameGamePath(activeInstall.value.path, path)) {
        const next = remaining[0] ?? null;
        await api.setGameConfig(next?.path ?? null);
        activeInstall.value = next;
      }
      invalidateScan();
      installs.value = remaining;
      if (target) {
        ignoredPaths.value = [...ignoredPaths.value, target.path];
        saveIgnoredGamePaths(ignoredPaths.value);
        gamePathOrder = gamePathOrder.filter((p) => !sameGamePath(p, target.path));
        saveGamePathOrder(gamePathOrder);
      }
    });
  }

  /** Reorder the install list (settings 游戏路径 rows, drag handles). The
   *  order is remembered webui-side (see GAME_PATH_ORDER_KEY) so it survives
   *  both a restart and a re-scan. */
  function reorderInstalls(from: number, to: number) {
    const arr = [...installs.value];
    const [moved] = arr.splice(from, 1);
    if (!moved) return;
    arr.splice(to, 0, moved);
    installs.value = arr;
    gamePathOrder = arr.map((i) => i.path);
    saveGamePathOrder(gamePathOrder);
  }

  /** Pin an extra replay folder into the scan (游玩时间 view's 录像来源
   *  manager). Rejects (throws) when the folder is missing or overlaps what
   *  the scan already covers — the caller surfaces the message. */
  async function addReplayDir(path: string) {
    const cfg = await api.addReplayDir(path);
    replayDirs.value = cfg?.replayDirs ?? replayDirs.value;
  }

  /** Unpin an extra replay folder (any spelling of its path). Its
   *  already-counted battles stay in the playtime ledger — removal stops
   *  future scans, it does not rewrite history. */
  async function removeReplayDir(path: string) {
    const cfg = await api.removeReplayDir(path);
    replayDirs.value = cfg?.replayDirs ?? replayDirs.value;
  }

  /** Whether an install path was removed from the list (settings 游戏路径
   *  row delete). Data surfaces filter rows by it so an ignored client's
   *  replays leave the rail/charts together with its list row. */
  function isIgnoredPath(path: string | null | undefined): boolean {
    if (!path) return false;
    return ignoredPaths.value.some((p) => sameGamePath(p, path));
  }

  return {
    installs,
    activeInstall,
    detecting,
    replayDirs,
    isIgnoredPath,
    detect,
    load,
    selectInstall,
    setManualPath,
    removeInstall,
    reorderInstalls,
    addReplayDir,
    removeReplayDir,
  };
});
