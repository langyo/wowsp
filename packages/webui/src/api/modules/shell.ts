/** App-shell domain of the WoWSP API client: OS/appdata, overlay config,
 *  in-game plugin/bridge, migrations, wallpapers/stamps, logs, network
 *  config and raw-IPC export helpers (composed into `api` by client.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";
import type { StampKind } from "@/utils/winrate";

/** One supporter's avatar resolution (mirrors
 *  `wowsp_tauri_shared::SupporterAvatar`, commands/supporters.rs). */
export interface SupporterAvatar {
  uid: number;
  /** Live or last-cached Bilibili avatar URL; null when neither exists. */
  face: string | null;
}

/** Mirrors `commands::wallpaper::WallpaperFile` — one user-imported wallpaper
 *  image under `<data_dir>/wallpapers/`. `id` doubles as the file name and
 *  the persisted selection key. */
export interface WallpaperFile {
  id: string;
  name: string;
  /** Absolute path — the frontend rewrites it into an asset-protocol URL. */
  path: string;
}

/** Mirrors `commands::stamps::StampOverride` — one user-set seal picture
 *  under `<data_dir>/stamps/`, keyed by stamp kind. */
export interface StampOverride {
  kind: string;
  /** Absolute path — the frontend rewrites it into an asset-protocol URL. */
  path: string;
}

/** Proxy mode + optional manual URL (mirrors the Rust NetworkConfig). */
export interface NetworkConfig {
  /** "system" (OS settings) | "none" (direct) | "manual" (fixed proxy URL). */
  mode: "system" | "none" | "manual";
  /** Manual proxy URL, e.g. "http://127.0.0.1:7890" (only for "manual"). */
  proxy?: string | null;
  /** Mirror base for remote resources (ship portraits etc.); empty → the
   *  official Wargaming CDN. See commands/media.rs. */
  resourceCdn?: string | null;
  /** ghproxy-style mirror prefix for GitHub downloads (resource packs, mod
   *  catalog); empty → direct GitHub with the built-in mirrors as fallback.
   *  See commands/model_pack.rs. */
  githubMirror?: string | null;
  /** OS proxy pre-resolved by the shell (read-only, for proxy-URL consumers). */
  effectiveProxy?: string | null;
}

/** One retained diagnostics-log file (`wowsp.<date>.log`, UTF-8 text).
 *  Mirrors `wowsp_tauri::commands::logs::LogFileInfo`. */
export interface LogFileInfo {
  name: string;
  path: string;
  sizeBytes: number;
  /** RFC 3339 (UTC); null when the filesystem didn't say. */
  modified?: string | null;
}

/** The diagnostics-log folder view for the settings' 问题反馈 section.
 *  Mirrors `wowsp_tauri::commands::logs::LogsOverview`. */
export interface LogsOverview {
  /** The folder the roller writes to (and the reveal button opens). */
  dir: string;
  /** Newest file; null until the first write of the day materializes it. */
  latest?: LogFileInfo | null;
  /** Retained files, newest first (the latest excluded). */
  files: LogFileInfo[];
  totalBytes: number;
  /** How many daily files the roller keeps before pruning. */
  retainedMax: number;
}

export const shellApi = {
  getOsPreferences: () => transport.invoke<{ locale: string; colorScheme: string }>(RPC.get_os_preferences),
  appdataRead: (file: string) => transport.invoke<string | null>(RPC.appdata_read, { file }),
  appdataWrite: (file: string, content: string) => transport.invoke<null>(RPC.appdata_write, { file, content }),
  appdataDelete: (file: string) => transport.invoke<null>(RPC.appdata_delete, { file }),
  /** Overlay switches (schema v2) — sanitized + persisted as TOML by the
   *  shell (see commands/overlay_config.rs). Unknown values reset to the
   *  field's default on the Rust side, so the response is always valid. */
  getOverlayConfig: () => transport.invoke<{ table: string; roster: string }>(RPC.get_overlay_config),
  setOverlayConfig: (table: string, roster: string) =>
    transport.invoke<{ table: string; roster: string }>(RPC.set_overlay_config, { table, roster }),
  /** The 游戏内展示 view mode's stats bridge (see commands/ingame_bridge.rs):
   *  start answers the in-game plugin's request.json with stats rows (the
   *  plugin then renders the panel inside the game), stop silences it.
   *  `locale` picks the panel's column labels. Desktop only — phones reject
   *  the invoke and callers treat that as "not running". */
  startIngameBridge: (locale?: string) =>
    transport.invoke<null>(RPC.ingame_bridge_start, { locale: locale ?? null }),
  stopIngameBridge: () => transport.invoke<null>(RPC.ingame_bridge_stop),
  /** In-game stats plugin presence in a game install (see
   *  commands/ingame_plugin.rs) — powers the roster "plugin detection"
   *  option's enabled state and its Discussions page link. */
  ingamePluginStatus: (gameRoot: string) =>
    transport.invoke<{ installed: boolean; outdated?: boolean; resMods: string; discussion: number }>(RPC.ingame_plugin_status, { gameRoot }),
  ingamePluginInstall: (gameRoot: string) =>
    transport.invoke<string>(RPC.ingame_plugin_install, { gameRoot }),
  ingamePluginUninstall: (gameRoot: string) =>
    transport.invoke<null>(RPC.ingame_plugin_uninstall, { gameRoot }),
  /** App-version one-time migrations (commands/app_migrations.rs — the
   *  hifumi ledger gate). Pending ids are the DELEGATED actions whose
   *  WebView bodies live in migrations/definitions.ts; previousHint is the
   *  webui's `wowsp-last-run-version` slot, consumed once to seed a fresh
   *  shell-side ledger. */
  appMigrationsPending: (previousHint: string | null) =>
    transport.invoke<string[]>(RPC.app_migrations_pending, { previousHint }),
  /** Report a delegated migration action as completed (records the ledger). */
  appMigrationCompleted: (id: string) =>
    transport.invoke<boolean>(RPC.app_migration_completed, { id }),
  /** List imported wallpapers in the fixed AppData `wallpapers/` folder. */
  wallpaperList: () => transport.invoke<WallpaperFile[]>(RPC.wallpaper_list),
  /** Native image picker → copy into the wallpapers folder. Null = the
   *  user cancelled the dialog. */
  wallpaperImport: () => transport.invoke<WallpaperFile | null>(RPC.wallpaper_import),
  wallpaperRemove: (id: string) => transport.invoke<null>(RPC.wallpaper_remove, { id }),
  /** Resolve the supporters' live Bilibili avatar URLs (About page
   *  special-thanks cards) — one entry per input uid, `face` null when neither
   *  a live answer nor a cached URL exists (the UI shows the initial
   *  letter). Never rejects on network failure. */
  getSupporterAvatars: (uids: number[]) =>
    transport.invoke<SupporterAvatar[]>(RPC.get_supporter_avatars, { uids }),
  /** List customized seals (kind-keyed pictures in the AppData `stamps/`
   *  folder). Kinds without a file fall back to the bundled glyph. */
  stampList: () => transport.invoke<StampOverride[]>(RPC.stamp_list),
  /** Native image picker → copy into the stamps folder as `<kind>.<ext>`.
   *  Null = the user cancelled the dialog. */
  stampImport: (kind: StampKind) =>
    transport.invoke<StampOverride | null>(RPC.stamp_import, { kind }),
  /** Delete the kind's custom picture — the seal falls back to the bundled
   *  glyph. */
  stampReset: (kind: StampKind) => transport.invoke<null>(RPC.stamp_reset, { kind }),
  captureMainWindow: (path: string) =>
    transport.invoke<string>(RPC.capture_main_window, { path }),
  /** Native save dialog for tactical-board exports (screenshots/video).
   *  Null = the user cancelled the dialog. */
  pickExportPath: (defaultName: string, filterName: string, filterExts: string[]) =>
    transport.invoke<string | null>(RPC.pick_export_path, {
      defaultName,
      filterName,
      filterExts,
    }),
  /** Write export bytes (PNG/WebP image, MP4/WebM video) to an absolute path
   *  from `pickExportPath` via a raw IPC body. Rejects outside the Tauri
   *  shell — callers fall back to a browser download. */
  saveExportBytes: (path: string, bytes: Uint8Array) =>
    transport.invokeRaw?.<null>(RPC.write_export_bytes, bytes, {
      "x-export-path": encodeURIComponent(path),
    }) ?? Promise.reject(new Error("raw IPC unavailable in this host")),
  /** Copy a PNG image onto the system clipboard (post-battle share shot) via
   *  a raw IPC body. Rejects on mobile (marker error) and outside the Tauri
   *  shell — callers fall back to the webview clipboard API. */
  copyImageToClipboard: (bytes: Uint8Array) =>
    transport.invokeRaw?.<null>(RPC.copy_image_to_clipboard, bytes, {}) ??
    Promise.reject(new Error("raw IPC unavailable in this host")),
  /** Diagnostics-log surface for the settings' 问题反馈 section. The folder
   *  overview is cheap (one read_dir); the reveal opens the system file
   *  manager with the newest log selected. */
  logsOverview: () => transport.invoke<LogsOverview>(RPC.logs_overview),
  logsRevealLatest: () => transport.invoke<null>(RPC.logs_reveal_latest),
  /** Last `lines` lines (default 120) of the newest log, UTF-8 text for
   *  clipboard sharing. */
  logsReadTail: (lines?: number) =>
    transport.invoke<string>(RPC.logs_read_tail, { lines: lines ?? null }),
  /** Write the feedback zip bundle (logs + UTF-8 manifest) into the logs
   *  folder, reveal it in the file manager, and return its path.
   *  `includeHardware` (only ever set after the consent dialog) also sweeps
   *  the machine's hardware/environment report into the bundle and may
   *  raise a UAC prompt via the app's elevated helper relaunch. */
  logsExportBundle: (includeHardware?: boolean) =>
    transport.invoke<string>(RPC.logs_export_bundle, {
      includeHardware: includeHardware ?? null,
    }),
  installOverlayMod: (gameRoot: string) =>
    transport.invoke<string>(RPC.install_overlay_mod, { gameRoot }),
  uninstallOverlayMod: (gameRoot: string) =>
    transport.invoke<null>(RPC.uninstall_overlay_mod, { gameRoot }),
  isOverlayModInstalled: (gameRoot: string) =>
    transport.invoke<boolean>(RPC.is_overlay_mod_installed, { gameRoot }),
  /** Network proxy settings (system / none / manual), applied globally.
   *  The setter returns the SANITIZED config the shell actually persisted
   *  (invalid values are corrected there — see commands/network.rs), so
   *  callers re-sync their UI from the response. */
  getNetworkConfig: () => transport.invoke<NetworkConfig>(RPC.get_network_config),
  setNetworkConfig: (config: NetworkConfig) =>
    transport.invoke<NetworkConfig>(RPC.set_network_config, { config }),
};
