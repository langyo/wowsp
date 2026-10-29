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

/** One row of the afdian sponsor list (mirrors
 *  `wowsp_tauri_shared::SponsorEntry` — the relay worker's public
 *  document; rows arrive pre-sorted by current-month paid, then
 *  all-time paid, then earliest first payment). */
export interface SponsorEntry {
  userId: string;
  name: string;
  /** https afdian CDN URL; null renders the initial-letter disc. */
  avatar: string | null;
  /** All-time actually-charged total, CNY. */
  allSum: number;
  /** Actually-charged total inside the current calendar month, CNY. */
  monthSum: number;
  /** A monthly plan was live when the relay last polled. */
  active: boolean;
  /** Unix seconds. */
  firstPay: number;
  /** Unix seconds. */
  lastPay: number;
  /** Game ID recognized in an order remark. DORMANT: the relay still
   *  parses and serves it, but the chip-to-lookup jump is parked (the
   *  UI currently ignores this field) — kept so re-enabling needs no
   *  worker or DTO change. */
  gameId: string | null;
}

/** The sponsor-list document (mirrors
 *  `wowsp_tauri_shared::SponsorListDoc`). */
export interface SponsorListDoc {
  /** Unix seconds of the relay poll that produced the document. */
  updatedAt: number;
  sponsors: SponsorEntry[];
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

/** Compile-time capabilities + the DirectML runtime probe. Mirrors
 *  `wowsp_tauri_shared::RuntimeCapabilities`. `aiInference` cannot be
 *  inferred from `portable`: a custom build may drop the `ai` cargo feature
 *  while still being a normal installer build. */
export interface RuntimeCapabilities {
  aiInference: boolean;
  portable: boolean;
  /** Windows AI builds carry `DirectML.dll` beside the executable. */
  directmlRequired: boolean;
  directmlPresent: boolean;
  directmlBytes: number | null;
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
  /** Compile-time feature probe used by the map/settings AI surfaces. */
  getRuntimeCapabilities: () =>
    transport.invoke<RuntimeCapabilities>(RPC.get_runtime_capabilities),
  appdataRead: (file: string) => transport.invoke<string | null>(RPC.appdata_read, { file }),
  appdataWrite: (file: string, content: string) => transport.invoke<null>(RPC.appdata_write, { file, content }),
  appdataDelete: (file: string) => transport.invoke<null>(RPC.appdata_delete, { file }),
  /** Overlay switches (schema v2) — sanitized + persisted as TOML by the
   *  shell (see commands/overlay_config.rs). Unknown values reset to the
   *  field's default on the Rust side, so the response is always valid.
   *  `aimCardHangPx` (logical px below the crosshair) is rounded and
   *  clamped ≥ 0 shell-side; the slider only offers 60–240.
   *  `chatPanel` is the battle-chat translation card's window switch and
   *  `chatPanelMaxLines` its per-battle line cap (clamped 3–30 shell-side). */
  getOverlayConfig: () =>
    transport.invoke<{
      table: string;
      roster: string;
      aimCard: boolean;
      aimCardHangPx: number;
      chatPanel: boolean;
      chatPanelMaxLines: number;
    }>(RPC.get_overlay_config),
  setOverlayConfig: (
    table: string,
    roster: string,
    aimCard: boolean,
    aimCardHangPx: number,
    chatPanel: boolean,
    chatPanelMaxLines: number,
  ) =>
    transport.invoke<{
      table: string;
      roster: string;
      aimCard: boolean;
      aimCardHangPx: number;
      chatPanel: boolean;
      chatPanelMaxLines: number;
    }>(RPC.set_overlay_config, {
      table,
      roster,
      aimCard,
      aimCardHangPx,
      chatPanel,
      chatPanelMaxLines,
    }),
  /** In-game stats plugin presence in a game install (see
   *  commands/ingame_plugin.rs) — powers the roster "plugin detection"
   *  option's enabled state and its Discussions page link.
   *
   *  `safeMode` means the install's `res_mods` is quarantined by the mod
   *  hub's safe mode (renamed to `res_mods.wowsp-disabled`), so `installed`
   *  reads false BY DESIGN — the LIVE tree genuinely carries no plugin. The
   *  UI must gate on this flag to offer the "turn mods back on and repair"
   *  recovery instead of an install the backend has to refuse. Optional
   *  because older shells predate the field: absent means "not in safe
   *  mode", so every consumer reads `=== true`. */
  ingamePluginStatus: (gameRoot: string) =>
    transport.invoke<{
      installed: boolean;
      outdated?: boolean;
      /** True when the mod hub's safe mode has quarantined this install's
       *  `res_mods`; absent from older shells (treat as false). */
      safeMode?: boolean;
      resMods: string;
      discussion: number;
    }>(RPC.ingame_plugin_status, { gameRoot }),
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
  /** The afdian sponsor list (credits section's bottom group) — live
   *  relay answer, else the AppData last-good cache, else an empty
   *  document. Rows are pre-sorted; never rejects on network failure. */
  getSponsorList: () => transport.invoke<SponsorListDoc>(RPC.get_sponsor_list),
  /** List customized seals (kind-keyed pictures in the AppData `stamps/`
   *  folder). Kinds without a file fall back to the bundled glyph. */
  stampList: () => transport.invoke<StampOverride[]>(RPC.stamp_list),
  /** Crop-dialog image bytes → save into the stamps folder as
   *  `<kind>.<ext>` (raw IPC body — same channel as writeExportBytes;
   *  headers carry the kind and extension, the body carries the file). */
  stampImportBytes: (kind: StampKind, ext: string, bytes: Uint8Array) =>
    transport.invokeRaw?.<StampOverride>(RPC.stamp_import_bytes, bytes, {
      "x-stamp-kind": kind,
      "x-stamp-ext": ext,
    }) ?? Promise.reject(new Error("raw IPC unavailable in this host")),
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
  /** Write a tactics plan-profile archive (profile.toml + plan JSONs) to a
   *  user-picked path; null = cancelled. Throws outside the Tauri shell. */
  saveTacticsProfile: (
    meta: unknown,
    plans: { name: string; json: string; parent?: string; branchT?: number }[],
    /** Pre-confirmed save target (the page fixed it when the map was
     *  chosen): writes straight there, skipping the dialog. */
    path?: string,
  ) =>
    transport.invoke<string | null>(RPC.tactics_profile_save, {
      meta,
      plans,
      path,
    }),
  /** Open + read a tactics plan-profile archive; null = cancelled. The
   *  payload carries the archive's own path so the host keeps saving to
   *  the file it opened. Throws on a malformed archive. */
  openTacticsProfile: () =>
    transport.invoke<{
      meta: unknown;
      plans: { name: string; json: string; parent?: string; branchT?: number }[];
      path: string;
    } | null>(RPC.tactics_profile_open),
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
   *  clipboard sharing (redacted backend-side, like the bundle). */
  logsReadTail: (lines?: number) =>
    transport.invoke<string>(RPC.logs_read_tail, { lines: lines ?? null }),
  /** Write the feedback zip bundle (logs + UTF-8 manifest, redacted on
   *  export — the files on disk stay raw) into the logs folder, reveal it
   *  in the file manager, and return its path.
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
