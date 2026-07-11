/**
 * Tauri IPC command names. The webui calls these via `transport.invoke(cmd)`,
 * which routes to `window.__TAURI__.core.invoke(cmd, args)` in the desktop
 * shell and to a fetch-based shim against the mock backend in the browser.
 *
 * Keep these strings in lock-step with the `#[tauri::command]` functions in
 * `packages/app/tauri/src/commands/`.
 */
export const RPC = {
  get_os_preferences: "get_os_preferences",
  detect_game_install: "detect_game_install",
  set_game_path: "set_game_path",
  read_replay_header: "read_replay_header",
  read_replay_positions: "read_replay_positions",
  list_replays: "list_replays",
  read_temp_arena_info: "read_temp_arena_info",
  start_arena_watcher: "start_arena_watcher",
  stop_arena_watcher: "stop_arena_watcher",
  capture_game_window: "capture_game_window",
  set_overlay_visible: "set_overlay_visible",
  lookup_player_stats: "lookup_player_stats",
  install_overlay_mod: "install_overlay_mod",
  uninstall_overlay_mod: "uninstall_overlay_mod",
  is_overlay_mod_installed: "is_overlay_mod_installed",
} as const;

export type RpcCommand = (typeof RPC)[keyof typeof RPC];
