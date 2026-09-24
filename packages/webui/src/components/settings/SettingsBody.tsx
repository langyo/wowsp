import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  BarChart3,
  Check,
  Copy,
  Copyright,
  FolderCog,
  FolderOpen,
  Globe,
  ImagePlus,
  Info,
  Languages,
  Layers,
  MonitorPlay,
  Moon,
  Palette,
  Plus,
  Power,
  RefreshCw,
  Smartphone,
  ScrollText,
  Sun,
  SunMoon,
  Trash2,
  UserRound,
} from "@lucide/vue";

import {
  HkButton,
  HkDivider,
  HkInput,
  HkModal,
  HkSettingsBody,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkOtpInput,
  HkRadio,
  HkSelect,
  HkSlider,
  HkSpinner,
  HkTabs,
  HkTag,
  getThemeTokens,
  themePresets,
  useTheme,
  useToast,
  type ModalAction,
  type HkSettingsSection,
} from "@celestia-island/hikari";

import { useWallpaper } from "@/theme/useWallpaper";
import { themePresetIds } from "@/theme";
import {
  setThemeModePreference,
  themeModePreference,
  type ThemeModePreference,
} from "@/theme/themeModePreference";
import {
  DPI_MAX,
  DPI_MIN,
  DPI_STEP,
  isDpiRisky,
  keepDpiScale,
  loadDpiScale,
  previewDpiScale,
  resetDpiScale,
  revertPreviewDpiScale,
  useAppliedDpiScale,
  useDpiCountdown,
} from "@/theme/dpiPrefs";
import { t, type Locale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { api, type GameInstall, type NetworkConfig } from "@/api";
import { isMobileApp, isTauri } from "@/utils/platform";
import { useRouter } from "vue-router";
import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import {
  useOverlayConfigStore,
  type RosterRecognitionMode,
  type TableAnchorMode,
} from "@/stores/overlayConfig";
import {
  availableSettingsSections,
  useSettingsUiStore,
  type SettingsSection,
} from "@/stores/settingsUi";
import { useCloseBehaviorStore, type CloseAction } from "@/stores/closeBehavior";
import { useCacheStore } from "@/stores/cache";
import { useUpdaterStore } from "@/stores/updater";
import { useChangelogStore } from "@/stores/changelog";
import { entryKey, usePairingStore } from "@/stores/pairing";
import { AboutContent } from "@/components/layout/AboutModal";
import { pickTelemetryNotice } from "@/components/layout/announcementVariants";
import AccountManagerContent from "@/components/account/AccountManagerContent";
import PlatformIcon from "@/components/base/PlatformIcon";
import AuthorMark from "@/components/base/AuthorMark";
import StatsPrefsControls from "@/components/stats/StatsPrefsControls";
import SealCustomizer from "@/components/stats/SealCustomizer";
import FontSizeControl from "@/components/layout/FontSizeControl";
import ChangelogSection from "@/components/settings/ChangelogSection";
import { ATTRIBUTIONS } from "@/data/attributions";
import { kindLabel } from "@/utils/installLabel";
import "../layout/SettingsModal.scss";

/** Hikari token → CSS rgb() color. */
function css(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

/**
 * Shared settings body: the section rail + the section cards. Rendered by
 * BOTH surfaces — the desktop modal (components/layout/SettingsModal) and
 * the phone-layout /settings page (views/SettingsView). Which surface is
 * showing the body is abstracted into the single `active` prop: section
 * identity lives in the settingsUi store (shared), while mount/refresh
 * side effects (net config load, cache refresh, DPI staged-notch escape
 * hatches) key off `active` so they fire identically when the modal opens
 * and when the page mounts.
 *
 * On the phone app build the gamePath, overlay and closeBehavior sections
 * are filtered out of the rail (no local game install / no overlay window
 * there / no tray or window close button to configure).
 */
export default defineComponent({
  name: "SettingsBody",
  props: {
    /** True while the hosting surface (modal or page) is showing this
     *  body — drives the open-time refreshes and the DPI discard hatch. */
    active: { type: Boolean, default: false },
  },
  setup(props) {
    const ui = useSettingsUiStore();
    const closeBehavior = useCloseBehaviorStore();
    const theme = useTheme();
    const wallpaper = useWallpaper();
    const lang = useLanguage();
    const overlayCfg = useOverlayConfigStore();
    // Windows OCR availability (an installed OCR language pack): the `ocr`
    // roster mode is exact but needs the OS engine — on systems where it was
    // stripped the option stays VISIBLE but disabled, so the user understands
    // why the preferred inferred mode is the only working pick besides off.
    // A stored `ocr` pick on such a machine falls back to inferred: the
    // backend leaves the pipeline dormant there, so keeping the value would
    // only promise chips the shell cannot deliver.
    const ocrAvailable = ref(true);
    onMounted(async () => {
      try {
        ocrAvailable.value = await api.overlayOcrAvailable();
      } catch {
        // missing command (mobile stand-in / old shell) — assume unusable so
        // the default inferred mode stays the obvious choice
        ocrAvailable.value = false;
      }
      if (!ocrAvailable.value) {
        await overlayCfg.load();
        if (overlayCfg.roster === "ocr") {
          void overlayCfg.setRoster("inferred");
        }
      }
    });
    const router = useRouter();
    // Phone-app build gate (desktop layout can still be narrow — that is
    // isMobile/isPhoneLayout, a different axis; see utils/platform).
    const mobileApp = isMobileApp();
    const configStore = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const toast = useToast();

    // ── game-path table (see the 游戏路径 section) ────────────────────────
    const pickingPath = ref(false);
    /** Whether the add-path dialog (detection / browse actions) is open. */
    const addPathOpen = ref(false);

    const installRows = computed<GameInstall[]>(() => configStore.installs);
    const activePath = computed(() => configStore.activeInstall?.path ?? "");
    const detecting = computed(() => configStore.detecting);

    // The process watcher synthesizes an install for a running exe that no
    // detected install claims — a one-click fallback row above the actions.
    const runningInstall = computed<GameInstall | null>(() => {
      const p = gameStatus.process;
      if (!p.running || !p.matchedInstall) return null;
      if (installRows.value.some((i) => i.path === p.matchedInstall!.path)) return null;
      if (p.matchedInstall.path === activePath.value) return null;
      return p.matchedInstall;
    });

    /** Follow a client switch to that realm's preferred account. */
    async function followRealm(realm?: string | null) {
      if (!realm) return;
      const switched = await accounts.autoSwitchRealm(realm);
      if (switched) {
        toast.info(t("account.autoSwitched", { name: switched.nickname }));
      }
    }

    async function activateInstall(i: GameInstall) {
      if (i.path === activePath.value) return;
      await configStore.selectInstall(i.path);
      await followRealm(i.realm);
      toast.info(t("common.gamePath.applied"));
    }

    /** Native folder picker → validate → pin as the active install.
     *  Resolves true only when a folder was picked and applied — false on
     *  cancel or error, so the add-path dialog stays open. */
    async function browseFolder(): Promise<boolean> {
      if (pickingPath.value) return false;
      pickingPath.value = true;
      try {
        // Null = the user closed the native dialog — not an error.
        const picked = await api.pickGameFolder();
        if (!picked) return false;
        await configStore.setManualPath(picked.path);
        await followRealm(picked.realm);
        toast.info(t("common.gamePath.applied"));
        return true;
      } catch (e) {
        toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || e}`);
        return false;
      } finally {
        pickingPath.value = false;
      }
    }

    /** Open the add-path dialog from the dashed section row. */
    function openAddPath() {
      addPathOpen.value = true;
    }

    async function useRunning() {
      const i = runningInstall.value;
      if (!i) return;
      pickingPath.value = true;
      try {
        await configStore.setManualPath(i.path);
        await followRealm(i.realm);
        toast.info(t("common.gamePath.applied"));
      } catch (e) {
        toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || e}`);
      } finally {
        pickingPath.value = false;
      }
    }

    // ── Solar clock indicator (informational) ──────────────────────────────
    // Shares the theme clock's resolution — no extra geo lookup here.
    const { geo, period } = theme;

    // ── wallpaper management (import + two-step delete) ───────────────────
    const importingWallpaper = ref(false);
    /** The wallpaper strip element — after a successful import it scrolls
     *  to the far end so the newly added card is visible. */
    const wallpaperRow = ref<HTMLDivElement | null>(null);
    /** Two-step delete confirm per custom wallpaper (id of the armed row). */
    const wallpaperArmed = ref<string | null>(null);

    async function importWallpaper() {
      if (importingWallpaper.value) return;
      importingWallpaper.value = true;
      try {
        // Null = the user dismissed the native picker — not an error;
        // only reveal the new card when one actually landed.
        const imported = await wallpaper.importCustom();
        if (imported) {
          await nextTick();
          const row = wallpaperRow.value;
          if (row) row.scrollTo({ left: row.scrollWidth, behavior: "smooth" });
        }
      } catch (e) {
        toast.error(`${t("settings.wallpaperImportFailed")}\n${(e as Error).message || e}`);
      } finally {
        importingWallpaper.value = false;
      }
    }

    async function removeWallpaper(id: string) {
      wallpaperArmed.value = null;
      try {
        await wallpaper.removeCustomById(id);
      } catch (e) {
        toast.error(`${t("settings.wallpaperRemoveFailed")}\n${(e as Error).message || e}`);
      }
    }

    function periodLabel(p: string): string {
      if (p === "day") return t("settings.periodDay");
      if (p === "dusk") return t("settings.periodDusk");
      return t("settings.periodNight");
    }

    // ── Network proxy (global for all outbound requests) ──────────────────
    // Mode changes apply immediately; the URL / resource CDN rows commit via
    // 保存 / Enter. `netLastSaved` mirrors what the backend holds so the save
    // button only lights up on a real change, and the saved URL stays visible
    // (greyed out) even while system/none mode is active.
    const netCfg = ref<NetworkConfig>({ mode: "system", proxy: null, resourceCdn: null });
    const netLastSaved = ref<NetworkConfig>({ mode: "system", proxy: null, resourceCdn: null });
    const netSavedFlash = ref(false);
    let netFlashTimer: number | undefined;

    const netDirty = computed(() => {
      const cur = netCfg.value;
      const last = netLastSaved.value;
      return (
        cur.mode !== last.mode ||
        (cur.proxy?.trim() || null) !== last.proxy ||
        (cur.resourceCdn?.trim() || null) !== last.resourceCdn
      );
    });

    onMounted(async () => {
      void overlayCfg.load();
      try {
        const cfg = await api.getNetworkConfig();
        netCfg.value = { ...cfg };
        netLastSaved.value = { ...cfg };
      } catch {
        // mock backend / older shell without the command — keep defaults
      }
    });

    async function selectNetMode(mode: NetworkConfig["mode"]) {
      if (netCfg.value.mode === mode) return;
      netCfg.value.mode = mode;
      await saveNet();
    }

    /** The canonical way users type a manual proxy: bare `host:port`.
     *  Prefix http:// so the shell's scheme validation accepts it instead
     *  of silently dropping the field (which would flip manual → system). */
    function normalizeProxyUrl(raw: string | null | undefined): string | null {
      const v = raw?.trim() ?? "";
      if (!v) return null;
      return v.includes("://") ? v : `http://${v}`;
    }

    async function saveNet() {
      // Re-fetch the CURRENT config so fields this section does not edit
      // (githubMirror — saved from the cache section — and future additions)
      // survive the round-trip instead of being reverted to mount-time
      // snapshots.
      let base: NetworkConfig;
      try {
        base = await api.getNetworkConfig();
      } catch {
        base = { ...netLastSaved.value };
      }
      const payload: NetworkConfig = {
        ...base,
        mode: netCfg.value.mode,
        proxy: normalizeProxyUrl(netCfg.value.proxy),
        resourceCdn: netCfg.value.resourceCdn?.trim() || null,
      };
      delete payload.effectiveProxy;
      try {
        // The shell sanitizes before persisting and returns what actually
        // landed — adopt THAT so the form never claims a proxy the HTTP
        // stack is not using (an invalid value would otherwise desync).
        // A backend without the response (mock / older shell) falls back
        // to the payload we sent.
        const saved = await api.setNetworkConfig(payload);
        const effective = saved ?? payload;
        netCfg.value = { ...effective };
        netLastSaved.value = { ...effective };
        netSavedFlash.value = true;
        window.clearTimeout(netFlashTimer);
        netFlashTimer = window.setTimeout(() => (netSavedFlash.value = false), 1600);
      } catch {
        // best-effort — the desktop shell persists it; mock has no backend
      }
    }

    // ── Updates (app binary + resource pack + mirror + aux caches) ─────
    const cacheStore = useCacheStore();
    const updater = useUpdaterStore();
    const changelog = useChangelogStore();
    // ── Pairing (phone ↔ desktop replay transfer) ───────────────────────
    // Desktop build: the SERVER section (toggle, big gateway-allocated code,
    // regenerate, LAN-fallback hint). Phone build: the CLIENT section (open
    // the pairing wizard from the replay view + manage paired computers).
    const pairingStore = usePairingStore();
    /** Clipboard route for the pairing code (the readonly OTP shows it big;
     *  copying is the desktop-to-phone handoff shortcut). */
    async function copyPin(pin: string) {
      if (!pin) return;
      try {
        await navigator.clipboard.writeText(pin);
        toast.success(t("settings.pairingPinCopied"));
      } catch {
        // Clipboard permission denied — the big OTP display is the fallback.
      }
    }
    /** Ask the gateway for a fresh pairing code (desktop regenerate). */
    const reallocBusy = ref(false);
    async function regenerateCode() {
      if (reallocBusy.value) return;
      reallocBusy.value = true;
      try {
        await pairingStore.reallocateCode();
      } catch {
        // surfaced via store.serverError; nothing else to do
      } finally {
        reallocBusy.value = false;
      }
    }
    /** Phone build: the wizard lives in the replay view — deep-link there
     *  and let ReplayView auto-open it (?pairing=1). */
    function openPairingWizard() {
      void router.push({ path: "/replay", query: { pairing: "1" } });
    }
    /** Desktop only: while the pairing section is visible and the server
     *  runs, poll the status so a gateway that comes up (or drops) flips
     *  the displayed code / mode hint without user action. */
    let pairingPoll: number | undefined;
    function stopPairingPoll() {
      window.clearInterval(pairingPoll);
      pairingPoll = undefined;
    }
    function startPairingPoll() {
      if (mobileApp) return;
      stopPairingPoll();
      pairingPoll = window.setInterval(() => {
        if (pairingStore.server?.running && !pairingStore.serverBusy) {
          void pairingStore.refreshServerStatus();
        }
      }, 3000);
    }
    onBeforeUnmount(stopPairingPoll);
    /** Mirror input draft; commits through the cache store (which spreads
     *  the rest of the network config). */
    const mirrorDraft = ref("");
    const mirrorSavedFlash = ref(false);
    let mirrorFlashTimer: number | undefined;
    /** Two-step delete confirm per pack (id of the armed row). */
    const clearArmed = ref<string | null>(null);
    /** Two-step aux-cache clear confirm (scope of the armed row). */
    const auxArmed = ref<string | null>(null);
    /** Common ghproxy presets — click to fill the input. The same set the
     *  app rotates through automatically (see github_mirror.rs), plus ghp.ci
     *  which the built-in ladder tries first. */
    const MIRROR_PRESETS = [
      "https://ghp.ci",
      "https://ghfast.top",
      "https://gh-proxy.com",
      "https://ghproxy.net",
    ] as const;

    const mirrorDirty = computed(
      () => (mirrorDraft.value.trim() || null) !== (cacheStore.githubMirror ?? null),
    );

    watch(
      () => ui.section,
      (id) => {
        // Leaving the section disarms any pending two-step confirm.
        clearArmed.value = null;
        auxArmed.value = null;
        wallpaperArmed.value = null;
        // Re-sync the wallpaper list with the AppData folder (also heals a
        // failed boot-time listing instead of staying empty all session).
        if (id === "appearance") void wallpaper.refreshCustom();
        if (id === "pairing") {
          void pairingStore.refreshServerStatus();
          startPairingPoll();
        } else {
          stopPairingPoll();
        }
        // The changelog feed streams from GitHub Releases on demand —
        // never at startup — so opening the section is what loads it.
        if (id === "changelog") void changelog.ensureLoaded();
        if (id !== "updates") return;
        void cacheStore.refreshStatus();
        void cacheStore.loadMirror().then(() => {
          mirrorDraft.value = cacheStore.githubMirror ?? "";
        });
        if (!cacheStore.updatesCheckedAt) void cacheStore.refreshUpdates();
      },
    );

    // The body can unmount when its surface closes (modal) or navigate
    // away (page), so reopening on the cache section would show stale
    // sizes/versions — refresh whenever the surface becomes active too.
    watch(
      () => props.active,
      (open) => {
        if (open && ui.section === "updates") {
          void cacheStore.refreshStatus();
          void cacheStore.refreshUpdates();
        }
        if (open && ui.section === "pairing") {
          void pairingStore.refreshServerStatus();
          startPairingPoll();
        }
        if (open && ui.section === "changelog") void changelog.ensureLoaded();
        if (!open) stopPairingPoll();
      },
    );

    // Direct deep-link landing (?section=pairing — e.g. the phone app's
    // settings route): the section watcher above only fires on CHANGE, which
    // a landing mount already missed — refresh once here so the section never
    // shows stale pairing state.
    if (ui.section === "pairing") {
      void pairingStore.refreshServerStatus();
      startPairingPoll();
    }
    if (ui.section === "changelog") void changelog.ensureLoaded();

    async function saveMirror() {
      if (!mirrorDirty.value) return;
      try {
        await cacheStore.saveMirror(mirrorDraft.value || null);
        mirrorDraft.value = cacheStore.githubMirror ?? "";
        mirrorSavedFlash.value = true;
        window.clearTimeout(mirrorFlashTimer);
        mirrorFlashTimer = window.setTimeout(() => (mirrorSavedFlash.value = false), 1600);
      } catch {
        // best-effort — desktop persists it
      }
    }

    /** Human-readable bytes (1 decimal under GB, integer above). */
    function formatBytes(n: number): string {
      if (!n) return "0 MB";
      if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
      if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
      return `${Math.max(1, Math.round(n / 1024))} KB`;
    }

    /** The release `updated_at` stamp shown as a local date-time. */
    function formatStamp(stamp?: string | null): string {
      if (!stamp) return t("settings.cacheVersionUnknown");
      const d = new Date(stamp);
      return Number.isNaN(d.getTime()) ? stamp : d.toLocaleString();
    }

    /** The display form of a tree hash — its LAST 6 hex chars, upper-case
     *  (the "game build id" convention the publisher's delta tags use). */
    function hash6(hash?: string | null): string {
      if (!hash) return t("settings.resVersionUnknown");
      return hash.slice(-6).toUpperCase();
    }

    /** True while an app update is pending (or streaming) — the resource
     *  pack must wait for it: app first, pack after the restart. */
    const appUpdatePending = computed(() => updater.available && !updater.portable);

    /** Aux-cache scope → i18n keys (unknown future scopes render raw). */
    const AUX_LABELS: Record<string, { title: string; desc: string }> = {
      "image-cache": {
        title: "settings.cacheAuxImageCache",
        desc: "settings.cacheAuxImageCacheDesc",
      },
      gameparams: {
        title: "settings.cacheAuxGameparams",
        desc: "settings.cacheAuxGameparamsDesc",
      },
      encyclopedia: {
        title: "settings.cacheAuxEncyclopedia",
        desc: "settings.cacheAuxEncyclopediaDesc",
      },
      community: {
        title: "settings.cacheAuxCommunity",
        desc: "settings.cacheAuxCommunityDesc",
      },
    };

    function auxTitle(scope: string): string {
      const key = AUX_LABELS[scope]?.title;
      return key ? t(key) : scope;
    }

    function auxDesc(scope: string): string {
      const key = AUX_LABELS[scope]?.desc;
      return key ? t(key) : "";
    }

    // ── interface scale (DPI) — staged slider over theme/dpiPrefs ────────
    // Dragging only stages a notch; Apply previews it and starts the
    // app-level countdown in dpiPrefs — the confirm modal rendered as a
    // sibling HkModal below is a pure view of that store (Keep persists,
    // "Revert now" / expiry restores). Closing the hosting surface or
    // leaving the appearance section (both unmount this control) discards
    // a staged notch and reverts a live preview.
    const dpiScale = ref<number | null>(loadDpiScale());
    const pendingDpi = ref<number | null>(null);
    const dpiCountdown = useDpiCountdown();
    const dpiAuto = computed(() => pendingDpi.value == null && dpiScale.value == null);

    function onDpiScaleChange(value: number) {
      pendingDpi.value = value;
    }

    function onDpiApply() {
      const pct = pendingDpi.value;
      if (pct == null) return;
      pendingDpi.value = null;
      previewDpiScale(pct);
    }

    function onDpiKeep() {
      keepDpiScale();
      dpiScale.value = loadDpiScale();
    }

    function onDpiAuto() {
      pendingDpi.value = null;
      dpiScale.value = null;
      resetDpiScale();
    }

    function onDpiRevertNow() {
      revertPreviewDpiScale();
    }

    // The control exists only while a surface is showing the appearance
    // section; losing either is the explicit escape hatch (shittim's
    // window-close grammar, re-expressed over the settingsUi store).
    const dpiMounted = computed(() => props.active && ui.section === "appearance");
    watch(dpiMounted, (mounted) => {
      if (mounted) return;
      pendingDpi.value = null;
      if (dpiCountdown.active) revertPreviewDpiScale();
      dpiScale.value = loadDpiScale();
    });
    // Ctrl/Cmd+Alt+0 can reset the scale from anywhere while this control is
    // on screen; the root-zoom ref (MutationObserver-fed) mirrors that into
    // the readout unless a staged notch or live preview owns the display.
    watch(useAppliedDpiScale(), () => {
      if (dpiCountdown.active || pendingDpi.value != null) return;
      dpiScale.value = loadDpiScale();
    });
    onBeforeUnmount(() => {
      if (dpiCountdown.active) revertPreviewDpiScale();
    });

    const dpiConfirmActions = computed<ModalAction[]>(() => [
      { label: t("settings.dpiKeep"), variant: "primary", onClick: onDpiKeep },
      { label: t("settings.dpiRevertNow"), variant: "secondary", onClick: onDpiRevertNow },
    ]);

    // ── section rail ────────────────────────────────────────────────────────
    // The left rail mirrors the main sidebar's nav look; only the active
    // section's card renders in the content pane. Section identity lives in
    // the settingsUi store so openers can land on a specific one. The phone
    // app build drops the gamePath / overlay / closeBehavior sections
    // (nothing to configure there).
    const SECTION_ICONS = {
      language: Languages,
      appearance: Palette,
      closeBehavior: Power,
      stats: BarChart3,
      gamePath: FolderCog,
      account: UserRound,
      network: Globe,
      pairing: Smartphone,
      updates: RefreshCw,
      changelog: ScrollText,
      overlay: Layers,
      about: Info,
      attributions: Copyright,
    };
    const sectionLabels = computed<Record<SettingsSection, string>>(() => ({
      language: t("settings.language"),
      appearance: t("settings.themeMode"),
      closeBehavior: t("settings.closeBehavior"),
      stats: t("settings.statsSection"),
      gamePath: t("settings.gamePath"),
      account: t("settings.account"),
      network: t("settings.network"),
      pairing: mobileApp ? t("settings.pairingMobile") : t("settings.pairing"),
      updates: t("settings.updates"),
      changelog: t("settings.changelog"),
      overlay: t("settings.overlay"),
      about: t("settings.about"),
      attributions: t("settings.attributions"),
    }));
    const sections = computed(() => availableSettingsSections());
    // The rail entries handed to HkSettingsBody — icons + labels resolved
    // here so the shared component owns only the rendering.
    const railSections = computed<HkSettingsSection[]>(() =>
      sections.value.map((id) => ({
        key: id,
        label: sectionLabels.value[id],
        icon: SECTION_ICONS[id],
      })),
    );
    // (Pane scroll ownership moved into HkSettingsBody — the shared
    // component restarts the pane from the top on section switches.)

    return () => {
      // Staged-or-persisted notch for the DPI slider/readout (null = Auto)
      // and its risk flag — same locals as the reference DpiControl window.
      const pending = pendingDpi.value;
      const staged = pending ?? dpiScale.value;
      const warningVisible = pending != null && isDpiRisky(pending, window.innerWidth);
      return (
        <>
        {/* The shell is hikari's HkSettingsBody now (the settings-window
            grammar this app's own rail+pane anatomy upstreamed,
            2026-09-23): rail rendering, active-section state, pane
            scrolling and the switch-restarts-at-top behavior all come
            from the shared component; this body keeps only the section
            content. Section identity stays in the settingsUi store so
            openers can land on a specific section. */}
        <HkSettingsBody
          sections={railSections.value}
          section={ui.section}
          onUpdate:section={(key: string) => (ui.section = key as SettingsSection)}
          navLabel={t("settings.title")}
        >
          {{
          language: () => (
          <>
          {/* language — two independent dropdowns: UI (app interface) vs data
              (game-asset names: ships/captains/maps). The same language can have
              different official translations across regions, e.g. 国服 simplified
              (animal names for IJN) vs 亚服 Chinese. */}
          <HkSettingsGroup title={t("settings.language")}>
            <div class="settings-modal__langs">
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.uiLanguage")}</span>
                <HkSelect
                  modelValue={lang.uiLocale.value}
                  onUpdate:modelValue={(v: string) => lang.setUiLocale(v as Locale)}
                  options={lang.uiLocaleOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.dataLanguage")}</span>
                <HkSelect
                  modelValue={lang.dataLanguage.value}
                  onUpdate:modelValue={(v: string) => lang.setDataLanguage(v)}
                  options={lang.wgLanguageOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>
            <HkSettingsHint>{t("settings.dataLanguageHint")}</HkSettingsHint>
          </HkSettingsGroup>

          </>
          ),
          appearance: () => (
          <>
          {/* appearance — mode, color preset, wallpaper, solar indicator */}
          <HkSettingsGroup title={t("settings.themeMode")}>
            {/* Three-way mode preference (wowsp's own key — see
                theme/themeModePreference): dark/light verbatim, solar =
                daylight-following (hikari "system"). The retired OS-follower
                mode migrates onto solar. Selection applies immediately. */}
            <HkTabs
              block
              variant="segmented"
              modelValue={themeModePreference.value}
              onUpdate:modelValue={(v: string) =>
                setThemeModePreference(v as ThemeModePreference)
              }
              tabs={[
                { key: "dark", label: t("settings.themeModeDark"), icon: <Moon size={14} /> },
                { key: "light", label: t("settings.themeModeLight"), icon: <Sun size={14} /> },
                { key: "solar", label: t("settings.themeModeSolar"), icon: <SunMoon size={14} /> },
              ]}
            />

            {/* color preset — uniform card chrome; the theme only peeks
                through the preview chip so the row reads as one control.
                Cards come from hikari's LIVE preset table on each render
                (themePresetIds, display order: Nord first, Synthwave '84
                last), so whatever the installed hikari ships gets a card —
                the four named looks, or the single `default` pair that
                replaced them — instead of a fixed id list that can match
                nothing at all. */}
            <HkSettingsSub title={t("settings.themePreset")}>
              <div class="settings-modal__presets">
                {themePresetIds().map((id) => {
                  // Use the effective mode so light-mode users see a light preview.
                  const tokens = getThemeTokens(id, theme.effectiveMode.value);
                  if (!tokens) return null;
                  const on = theme.currentTheme.value === id;
                  return (
                    <button
                      type="button"
                      aria-pressed={on}
                      class={["settings-modal__preset", on ? "settings-modal__preset--on" : ""]}
                      onClick={() => theme.setTheme(id)}
                    >
                      <span class="settings-modal__preset-preview" style={{ background: css(tokens.background) }}>
                        <span class="settings-modal__preset-dot" style={{ background: css(tokens.primary) }} />
                        <span class="settings-modal__preset-dot" style={{ background: css(tokens.accent) }} />
                        <span class="settings-modal__preset-dot" style={{ background: css(tokens.success) }} />
                      </span>
                      <span class="settings-modal__preset-name">{themePresets[id].name}</span>
                      {on ? <Check size={14} class="settings-modal__preset-check" /> : null}
                    </button>
                  );
                })}
              </div>
            </HkSettingsSub>

            <HkDivider />

            {/* wallpaper / background — solid follows the theme mode; custom
                entries are files in the AppData wallpapers folder and can be
                deleted (two-step confirm per card). */}
            <HkSettingsSub title={t("settings.wallpaper")}>
              <div class="settings-modal__wallpapers" ref={wallpaperRow}>
                {wallpaper.allWallpapers.value.map((w) => {
                  const on = wallpaper.activeWallpaperId.value === w.id;
                  const custom = w.nameKey == null;
                  return (
                    <div
                      key={w.id}
                      class={[
                        "settings-modal__wallpaper",
                        on ? "settings-modal__wallpaper--on" : "",
                      ]}
                    >
                      <button
                        type="button"
                        aria-pressed={on}
                        class="settings-modal__wallpaper-pick"
                        onClick={() => wallpaper.setActiveWallpaper(w.id)}
                      >
                        <span class="settings-modal__wallpaper-preview">
                          {w.source.type === "solid" ? (
                            // Live swatch: the theme's own background.
                            <span
                              class="settings-modal__wallpaper-swatch"
                              style={{ background: "rgb(var(--color-background))" }}
                            />
                          ) : (
                            <span
                              class="settings-modal__wallpaper-swatch settings-modal__wallpaper-swatch--image"
                              style={{ backgroundImage: `url(${w.source.url})` }}
                            />
                          )}
                        </span>
                        <span class="settings-modal__wallpaper-name">
                          {w.nameKey ? t(w.nameKey) : w.name}
                        </span>
                        {on ? <Check size={12} class="settings-modal__wallpaper-check" /> : null}
                      </button>
                      {custom ? (
                        wallpaperArmed.value === w.id ? (
                          <button
                            type="button"
                            class="settings-modal__wallpaper-delete settings-modal__wallpaper-delete--confirm"
                            onClick={() => void removeWallpaper(w.id)}
                          >
                            {t("settings.wallpaperDeleteConfirm")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            class="settings-modal__wallpaper-delete"
                            title={t("settings.wallpaperDelete")}
                            aria-label={t("settings.wallpaperDelete")}
                            onClick={() => (wallpaperArmed.value = w.id)}
                          >
                            <Trash2 size={12} />
                          </button>
                        )
                      ) : null}
                    </div>
                  );
                })}
                {/* dashed add tile — the row's last item; opens the native
                    import picker (Tauri only). Matches the dashed add-row
                    pattern used by the account / game-path sections. */}
                {isTauri() ? (
                  <button
                    type="button"
                    class={["settings-modal__wallpaper-add", importingWallpaper.value ? "settings-modal__wallpaper-add--busy" : ""]}
                    disabled={importingWallpaper.value}
                    aria-label={t("settings.wallpaperImport")}
                    onClick={() => void importWallpaper()}
                  >
                    <span class="settings-modal__wallpaper-add-frame">
                      <ImagePlus size={16} />
                    </span>
                    <span class="settings-modal__wallpaper-add-label">{t("settings.wallpaperImport")}</span>
                  </button>
                ) : null}
              </div>
              {/* Overlay strength over image wallpapers — the transparency
                  dial (wallpaperOverlay.ts); meaningless for solid, which
                  never draws a scrim, so it only renders while an image is
                  active. Applies live for instant preview. */}
              {wallpaper.isImage.value ? (
                <div class="settings-modal__dpi-row">
                  <span class="settings-modal__overlay-label">
                    {t("settings.wallpaperOverlay")}
                  </span>
                  <HkSlider
                    class="settings-modal__dpi-slider"
                    min={0}
                    max={100}
                    step={5}
                    modelValue={wallpaper.overlayPercent.value}
                    onUpdate:modelValue={wallpaper.setOverlayPercent}
                    ariaLabel={t("settings.wallpaperOverlay")}
                    formatValue={(v: number) => `${v}%`}
                  />
                  <span class="settings-modal__dpi-value">
                    {wallpaper.overlayPercent.value}%
                  </span>
                </div>
              ) : null}
              <HkSettingsHint>{t("settings.wallpaperHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* font size — global --text-* token scaling (see
                theme/fontScalePreference): the whole UI rescales except the
                title bar and the sidebar's app title, which are pinned. */}
            <HkSettingsSub title={t("settings.fontSize")}>
              <FontSizeControl ns="settings" />
              <HkSettingsHint>{t("settings.fontSizeHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* interface scale (DPI) — root CSS `zoom` over everything (see
                theme/dpiPrefs): dragging stages a notch, Apply previews it
                under the app-level countdown; the confirm dialog lives at
                the bottom of this component as a sibling modal. The risk
                warning flags scales that squeeze the viewport under the
                usable layout-width floor. */}
            <HkSettingsSub title={t("settings.dpiTitle")}>
              <div class="settings-modal__dpi-row">
                <HkSlider
                  class="settings-modal__dpi-slider"
                  min={DPI_MIN}
                  max={DPI_MAX}
                  step={DPI_STEP}
                  showTicks
                  modelValue={staged ?? DPI_MIN}
                  onUpdate:modelValue={onDpiScaleChange}
                  ariaLabel={t("settings.dpiTitle")}
                  formatValue={(v: number) => `${v}%`}
                />
                <span class="settings-modal__dpi-value">
                  {staged == null ? t("settings.dpiAuto") : `${staged}%`}
                </span>
              </div>
              {warningVisible ? (
                <p class="settings-modal__dpi-warning">
                  {t("settings.dpiRiskyWarning", { scale: pending })}
                </p>
              ) : null}
              <div class="settings-modal__dpi-actions">
                <HkButton
                  variant="secondary"
                  size="sm"
                  disabled={dpiAuto.value}
                  onClick={onDpiAuto}
                >
                  {t("settings.dpiAuto")}
                </HkButton>
                {pendingDpi.value != null ? (
                  <HkButton variant="primary" size="sm" onClick={onDpiApply}>
                    {t("settings.dpiApply")}
                  </HkButton>
                ) : null}
              </div>
              <HkSettingsHint>{t("settings.dpiHint")}</HkSettingsHint>
              {/* The guaranteed way back, readable even at a scale that
                  breaks the modal itself: the keyboard hatch works anywhere
                  (capture-phase, dpiPrefs), so the reset never depends on
                  this UI being reachable. */}
              <HkSettingsHint>{t("settings.dpiResetHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* solar status — what "Auto (sun)" currently resolves to */}
            <p class="settings-modal__geoline">
              <span>
                {t("settings.currentPeriod")}: <strong>{periodLabel(period.value)}</strong>
              </span>
              {geo.value ? (
                <span class="settings-modal__geo-coords">
                  {geo.value.lat.toFixed(2)}°, {geo.value.lng.toFixed(2)}°
                </span>
              ) : null}
            </p>
            <HkSettingsHint>{t("settings.geolocationHint")}</HkSettingsHint>
          </HkSettingsGroup>

          </>
          ),
          closeBehavior: () => (
          <>
          {/* closeBehavior — the only place to read, change or clear what the
              close dialog's "remember my choice" checkbox wrote: without it
              a remembered choice is a one-way trip (the dialog never asks
              again). Same store the dialog uses, so the two cannot disagree;
              the minimize/quit labels reuse the dialog's tray.* strings so
              the wording cannot drift apart either. */}
          <HkSettingsGroup title={t("settings.closeBehavior")}>
            <HkRadio
              direction="vertical"
              modelValue={closeBehavior.action}
              onUpdate:modelValue={(v: string | number) =>
                closeBehavior.setAction(v as CloseAction)
              }
              options={[
                { value: "ask", label: t("settings.closeAsk") },
                { value: "minimize", label: t("tray.minimize") },
                { value: "quit", label: t("tray.quit") },
              ]}
            />
            <HkSettingsHint>{t("settings.closeBehaviorHint")}</HkSettingsHint>
            <HkSettingsHint>{t("settings.closeRememberHint")}</HkSettingsHint>
          </HkSettingsGroup>

          </>
          ),
          stats: () => (
          <>
          {/* 战绩 (water-table prefs) — the same four controls as the
              onboarding wizard's preferences step (StatsPrefsControls),
              reading/writing the shared statsPrefs store. */}
          <HkSettingsGroup title={t("settings.statsSection")}>
            <HkSettingsHint>{t("settings.statsSectionHint")}</HkSettingsHint>
            <StatsPrefsControls ns="settings" />
            <SealCustomizer />
          </HkSettingsGroup>

          </>
          ),
          gamePath: () => (
          <>
          {/* game path — every known install (detected clients + manual pins)
              as a rich card mirroring the 账户 list: platform badge on the
              left, client + realm tag + path in the body; clicking a card
              activates it, which switches the app-wide client context
              (replay list, armor/ballistics loader, stats realm) and follows
              that realm's preferred account. A dashed add row at the end
              opens the dialog hosting detection and the native folder
              picker. Unreachable on the phone app build (the rail filters
              the section out). */}
          <HkSettingsGroup title={t("settings.gamePath")}>
            <HkSettingsHint>{t("common.gamePath.desc")}</HkSettingsHint>
            {installRows.value.length === 0 ? (
              <HkSettingsHint>{t("common.gamePath.noneFound")}</HkSettingsHint>
            ) : (
              <div class="settings-modal__installs">
                {installRows.value.map((i) => {
                  const active = i.path === activePath.value;
                  return (
                    <button
                      key={i.path}
                      type="button"
                      class={["install-card", active ? "install-card--active" : ""]}
                      onClick={() => void activateInstall(i)}
                    >
                      <PlatformIcon kind={i.kind} size={38} />
                      <span class="install-card__body">
                        <span class="install-card__head">
                          <span class="install-card__name">{kindLabel(i.kind)}</span>
                          {i.realm ? (
                            <HkTag variant="default" size="sm">{i.realm.toUpperCase()}</HkTag>
                          ) : null}
                          {active ? <Check size={12} class="install-card__check" /> : null}
                        </span>
                        <span class="install-card__path" title={i.path}>{i.path}</span>
                      </span>
                      {active ? (
                        <HkTag variant="success" size="sm">{t("common.gamePath.inUse")}</HkTag>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
            {runningInstall.value ? (
              <div class="settings-modal__running">
                <MonitorPlay size={14} />
                <HkSettingsHint>
                  {t("common.gamePath.runningHint", { path: runningInstall.value.path })}
                </HkSettingsHint>
                <HkButton size="sm" variant="secondary" onClick={() => void useRunning()}>
                  {t("common.gamePath.useRunning")}
                </HkButton>
              </div>
            ) : null}
            {/* dashed add placeholder — the section's last row; opens the
                dialog with the detection / browse actions instead of an
                always-visible action row. */}
            <button type="button" class="settings-modal__install-add" onClick={() => openAddPath()}>
              <Plus size={14} /> {t("common.gamePath.addAction")}
            </button>
            {/* add-path dialog — re-detect installs or browse to a folder
                manually; closes as soon as detection finishes / a folder is
                actually applied (a cancelled picker or a failed scan keeps
                it open). */}
            <HkModal
              modelValue={addPathOpen.value}
              onUpdate:modelValue={(v: boolean) => (addPathOpen.value = v)}
              title={t("common.gamePath.addTitle")}
              width="26rem"
            >
              <HkSettingsHint>{t("common.gamePath.addDesc")}</HkSettingsHint>
              <div class="settings-modal__addpath-actions">
                <HkButton
                  variant="secondary"
                  loading={detecting.value}
                  onClick={async () => {
                    try {
                      await configStore.detect();
                      addPathOpen.value = false;
                    } catch (e) {
                      toast.error(`${(e as Error).message || e}`);
                    }
                  }}
                >
                  <RefreshCw size={14} /> {t("common.gamePath.redetect")}
                </HkButton>
                <HkButton
                  variant="secondary"
                  loading={pickingPath.value}
                  onClick={async () => {
                    const ok = await browseFolder();
                    if (ok) addPathOpen.value = false;
                  }}
                >
                  <FolderOpen size={14} /> {t("common.gamePath.browse")}
                </HkButton>
              </div>
            </HkModal>
          </HkSettingsGroup>

          </>
          ),
          account: () => (
          <>
          {/* account — the binder/switcher body shared with the dashboard's
              modal entry: search → bind, rich cards for every bound account,
              click to activate. Switching here leaves the section open (the
              wrapper modal closes instead). */}
          <HkSettingsGroup title={t("settings.account")}>
            <HkSettingsHint>{t("settings.accountHint")}</HkSettingsHint>
            <AccountManagerContent />
          </HkSettingsGroup>
          </>
          ),
          network: () => (
          <>
          {/* network proxy — applies to every outbound request (stats, model
              pack, updates); resource CDN mirrors remote resources
              independently of the proxy mode */}
          <HkSettingsGroup title={t("settings.network")}>
            <HkSettingsHint>{t("settings.networkHint")}</HkSettingsHint>
            <HkTabs
              block
              variant="segmented"
              modelValue={netCfg.value.mode}
              onUpdate:modelValue={(v: string) => void selectNetMode(v as NetworkConfig["mode"])}
              tabs={[
                { key: "system", label: t("settings.networkSystem") },
                { key: "none", label: t("settings.networkNone") },
                { key: "manual", label: t("settings.networkManual") },
              ]}
            />
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  modelValue={netCfg.value.proxy ?? ""}
                  onUpdate:modelValue={(v: string) => (netCfg.value.proxy = v)}
                  placeholder={t("settings.networkProxyPlaceholder")}
                  disabled={netCfg.value.mode !== "manual"}
                  submitOnEnter={() => void saveNet()}
                />
              </div>
              <HkButton size="sm" disabled={!netDirty.value} onClick={() => void saveNet()}>
                {netSavedFlash.value ? t("settings.networkSaved") : t("settings.networkSave")}
              </HkButton>
            </div>
            {/* Resource CDN — an independent setting, not gated on the proxy
                mode; commits via 保存 / Enter like the proxy URL. */}
            <div class="settings-modal__netinput">
              <HkInput
                modelValue={netCfg.value.resourceCdn ?? ""}
                onUpdate:modelValue={(v: string) => (netCfg.value.resourceCdn = v)}
                placeholder={t("settings.resourceCdnPlaceholder")}
                submitOnEnter={() => void saveNet()}
              />
            </div>
            <HkSettingsHint>{t("settings.resourceCdnHint")}</HkSettingsHint>
          </HkSettingsGroup>

          </>
          ),
          pairing: () =>
          mobileApp ? (
          <>
          {/* phone pairing — the PHONE (client) side. Discoverability
              first: the section the owner could not find. One primary
              action opens the replay view's pairing wizard (deep-linked
              via ?pairing=1), plus the paired computers with forget
              buttons and last-synced info. */}
          <HkSettingsGroup title={t("settings.pairingMobile")}>
            <HkSettingsHint>{t("settings.pairingMobileHint")}</HkSettingsHint>
            <div class="settings-modal__pairing-open">
              <HkButton variant="primary" onClick={openPairingWizard}>
                <Smartphone size={15} />
                {t("settings.pairingOpenWizard")}
              </HkButton>
            </div>
            {pairingStore.hosts.length > 0 ? (
              <>
                <HkSettingsSub title={t("settings.pairingPairedHosts")} />
                <ul class="settings-modal__paired-hosts">
                  {pairingStore.hosts.map((h) => (
                    <li key={entryKey(h)} class="settings-modal__paired-host">
                      <span class="settings-modal__paired-host-body">
                        <span class="settings-modal__paired-host-label">{h.label}</span>
                        <span class="settings-modal__paired-host-meta">
                          {h.lastSeen > 0
                            ? t("settings.pairingLastSynced", {
                                time: new Date(h.lastSeen).toLocaleString(),
                              })
                            : t("settings.pairingNeverSynced")}
                        </span>
                      </span>
                      <HkButton
                        size="sm"
                        variant="secondary"
                        ariaLabel={t("settings.pairingForget")}
                        onClick={() => pairingStore.removeEntry(h)}
                      >
                        <Trash2 size={14} />
                        {t("settings.pairingForget")}
                      </HkButton>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </HkSettingsGroup>
          </>
          ) : (

          <>
          {/* phone pairing — the DESKTOP side. Runs the pairing server the
              mobile app connects to: toggle on, then read the code into the
              phone's replay → "get from PC" wizard. The displayed code is
              the GATEWAY-ALLOCATED pairing code while the built-in internet
              gateway is online (relay mode); when it is unreachable the
              desktop falls back to its LAN PIN and shows a LAN-only hint.
              There is deliberately NO relay URL field: the gateway endpoint
              is built into both apps. */}
          <HkSettingsGroup title={t("settings.pairing")}>
            <HkSettingsHint>{t("settings.pairingHint")}</HkSettingsHint>
            <HkTabs
              block
              variant="segmented"
              modelValue={pairingStore.server?.running ? "on" : "off"}
              onUpdate:modelValue={(v: string) =>
                void (v === "on" ? pairingStore.startServer() : pairingStore.stopServer())
              }
              tabs={[
                { key: "off", label: t("settings.pairingOff") },
                { key: "on", label: t("settings.pairingOn") },
              ]}
            />
            {pairingStore.serverBusy ? (
              <p class="settings-modal__pairing-busy">
                <HkSpinner size="sm" tone="current" />
              </p>
            ) : null}
            {pairingStore.serverError ? (
              <p class="settings-modal__pack-error">{pairingStore.serverError}</p>
            ) : null}
            {pairingStore.server?.running ? (
              <div class="settings-modal__pairing-live">
                {/* The code is the whole pairing UX on the phone side — show
                    it big through the same hikari OTP grid the phone types
                    into (readonly), with copy + regenerate actions. */}
                <div class="settings-modal__pairing-pin">
                  <HkOtpInput
                    length={6}
                    separated
                    size="lg"
                    readonly
                    modelValue={pairingStore.server.pin ?? ""}
                    ariaLabel={t("settings.pairingPin")}
                    style={{ "--hk-otp-font-size": "1.6rem" } as Record<string, string>}
                  />
                  <div class="settings-modal__pairing-pin-actions">
                    <HkButton
                      size="sm"
                      variant="secondary"
                      ariaLabel={t("settings.pairingPinCopy")}
                      onClick={() => void copyPin(pairingStore.server?.pin ?? "")}
                    >
                      <Copy size={14} />
                      {t("settings.pairingPinCopy")}
                    </HkButton>
                    <HkButton
                      size="sm"
                      variant="secondary"
                      loading={reallocBusy.value}
                      disabled={!pairingStore.server.relayOnline}
                      ariaLabel={t("settings.pairingRegenerate")}
                      onClick={() => void regenerateCode()}
                    >
                      <RefreshCw size={14} />
                      {t("settings.pairingRegenerate")}
                    </HkButton>
                  </div>
                </div>
                <HkSettingsHint>
                  {pairingStore.server.relayOnline
                    ? t("settings.pairingPhoneHintInternet")
                    : t("settings.pairingPhoneHint")}
                </HkSettingsHint>
                {/* Gateway status: relay mode vs the LAN-only fallback. */}
                {pairingStore.server.relayOnline ? (
                  <p class="settings-modal__pairing-mode">
                    <HkTag variant="success" size="sm">{t("settings.pairingModeRelay")}</HkTag>
                  </p>
                ) : (
                  <p class="settings-modal__packs-banner">{t("settings.pairingLanOnly")}</p>
                )}
                {/* Address: auxiliary small print — discovery makes typing it
                    unnecessary on a normal LAN; kept for manual fallback. */}
                <div class="settings-modal__pairing-row">
                  <span class="settings-modal__pairing-label">
                    {t("settings.pairingAddress")}
                  </span>
                  {/* Selectable text — the manual fallback copies from here. */}
                  <code class="settings-modal__pairing-value">
                    {pairingStore.server.host}:{pairingStore.server.port}
                  </code>
                </div>
              </div>
            ) : (
              <HkSettingsHint>{t("settings.pairingIdleHint")}</HkSettingsHint>
            )}
          </HkSettingsGroup>
          </>
          ),
          updates: () => (
          <>
          {/* updates — the app-binary card and the single content-addressed
              resource-pack card (download / update / delete with live
              progress), the GitHub mirror source for mainland networks, and
              clearable auxiliary caches. APP UPDATES GO FIRST: while a
              newer build is pending the pack's buttons are disabled and the
              hint says so — the pack update follows after the restart.
              Pack versions are content tree hashes shown as their last 6
              hex chars; an outdated pack offers the retained chain patches
              (incremental) or falls back to the full archive. The phone app
              build ships through the store pipeline — its app-binary card
              is dropped entirely (checks are also silenced at the shell). */}
          {!isMobileApp() ? (
          <HkSettingsGroup>
            <div class="settings-modal__packs-head">
              <h2 class="hk-settings-group-title">{t("settings.updatesAppTitle")}</h2>
              <HkButton
                size="sm"
                loading={updater.checking}
                disabled={updater.portable}
                onClick={() => void updater.check()}
              >
                {t("settings.cacheCheckUpdates")}
              </HkButton>
            </div>
            <HkSettingsHint>{t("settings.updatesAppHint")}</HkSettingsHint>
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">{t("settings.updatesAppName")}</span>
                <span class="settings-modal__pack-desc">{t("settings.updatesAppDesc")}</span>
                <span class="settings-modal__pack-meta">
                  {t("settings.updatesCurrent")}: {updater.current || "—"}
                  {" · "}
                  {t("settings.updatesLatest")}
                  {": "}
                  {updater.available ? (updater.version ?? "—") : t("settings.updatesUpToDate")}
                </span>
                {updater.running ? (
                  <span class="settings-modal__pack-update">{updater.statusText}</span>
                ) : null}
                {updater.error ? (
                  <span class="settings-modal__pack-error">{updater.error}</span>
                ) : null}
              </div>
              <div class="settings-modal__pack-actions">
                {updater.portable ? (
                  <HkSettingsHint>{t("settings.updatesPortable")}</HkSettingsHint>
                ) : updater.available ? (
                  <HkButton
                    variant="primary"
                    size="sm"
                    disabled={updater.running}
                    onClick={() => void updater.downloadAndInstall()}
                  >
                    {t("settings.updatesAppNow")}
                  </HkButton>
                ) : null}
              </div>
            </div>
          </HkSettingsGroup>
          ) : null}
          <HkSettingsGroup>
            <div class="settings-modal__packs-head">
              <h2 class="hk-settings-group-title">{t("settings.resPackTitle")}</h2>
              <HkButton
                size="sm"
                loading={cacheStore.updatesLoading}
                onClick={() => void cacheStore.refreshUpdates()}
              >
                {t("settings.cacheCheckUpdates")}
              </HkButton>
            </div>
            <HkSettingsHint>
              {mobileApp ? t("settings.resPackMobileHint") : t("settings.resPackHint")}
            </HkSettingsHint>
            {cacheStore.anyUpdateAvailable ? (
              <p class="settings-modal__packs-banner">{t("settings.cacheUpdateBanner")}</p>
            ) : null}
            {appUpdatePending.value ? (
              <p class="settings-modal__packs-banner">{t("settings.resAfterApp")}</p>
            ) : null}
            {(() => {
              const st = cacheStore.status;
              const upd = cacheStore.update;
              const prog = cacheStore.progress;
              const downloading =
                (st?.downloading ?? false) ||
                (prog != null && (prog.phase === "download" || prog.phase === "apply"));
              const pct =
                prog && prog.phase === "download" && prog.total > 0
                  ? Math.min(100, Math.round((prog.received / prog.total) * 100))
                  : 0;
              const deltaSteps = upd?.deltaSteps;
              return (
                <div class="settings-modal__pack">
                  <div class="settings-modal__pack-info">
                    <span class="settings-modal__pack-name">{t("settings.resPackName")}</span>
                    <span class="settings-modal__pack-desc">{t("settings.resPackDesc")}</span>
                    <span class="settings-modal__pack-meta">
                      {st?.bundled
                        ? // Phone build, bundle serving: identity comes from
                          // the APK manifest; there is no cache size to show.
                          t("settings.resBundledInUse")
                        : st?.present
                          ? formatBytes(st.sizeBytes)
                          : t("settings.cacheStatusMissing")}
                      {" · "}
                      {t("settings.resCurrent")}
                      {": "}
                      {st?.legacyStamp ? t("settings.resLegacy") : hash6(st?.treeSha256)}
                      {st?.version && !st.legacyStamp ? ` · ${formatStamp(st.version)}` : ""}
                      {" · "}
                      {t("settings.resLatest")}
                      {": "}
                      {hash6(upd?.latestTreeSha256)}
                    </span>
                    {upd?.updateAvailable && !downloading ? (
                      <span class="settings-modal__pack-update">
                        {deltaSteps == null
                          ? t("settings.cacheUpdateAvailable")
                          : deltaSteps.length > 0
                            ? t("settings.resDeltaAvailable", { n: deltaSteps.length })
                            : t("settings.resFullDownload")}
                      </span>
                    ) : null}
                    {downloading ? (
                      <div class="settings-modal__pack-progress">
                        <div
                          class="settings-modal__pack-progress-fill"
                          style={{ width: prog?.phase === "apply" ? "100%" : `${pct}%` }}
                        />
                        {prog && prog.segments > 1 ? (
                          <span class="settings-modal__pack-desc">
                            {t("settings.resSegment", {
                              current: prog.segment,
                              total: prog.segments,
                            })}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {prog?.phase === "error" && prog.error ? (
                      <span class="settings-modal__pack-error">
                        {t("settings.cacheDownloadFailed")}: {prog.error}
                      </span>
                    ) : null}
                    {st?.bundled && !downloading ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resBundledClearNote")}
                      </span>
                    ) : null}
                  </div>
                  <div class="settings-modal__pack-actions">
                    {downloading ? (
                      <HkButton size="sm" onClick={() => void cacheStore.cancel()}>
                        {prog?.phase === "apply"
                          ? t("settings.cacheApplying")
                          : t("settings.cacheCancel")}
                      </HkButton>
                    ) : st?.present ? (
                      <>
                        <HkButton
                          variant="primary"
                          size="sm"
                          disabled={upd == null || !upd.updateAvailable || appUpdatePending.value}
                          onClick={() => void cacheStore.download()}
                        >
                          {t("settings.cacheUpdate")}
                        </HkButton>
                        {clearArmed.value === "res" ? (
                          <HkButton
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              clearArmed.value = null;
                              void cacheStore.clearRes();
                            }}
                          >
                            {t("settings.cacheDeleteConfirm")}
                          </HkButton>
                        ) : (
                          <HkButton
                            variant="secondary"
                            size="sm"
                            onClick={() => (clearArmed.value = "res")}
                          >
                            {t("settings.cacheDelete")}
                          </HkButton>
                        )}
                      </>
                    ) : (
                      <HkButton
                        variant="primary"
                        size="sm"
                        disabled={appUpdatePending.value}
                        onClick={() => void cacheStore.download()}
                      >
                        {t("settings.cacheDownload")}
                      </HkButton>
                    )}
                  </div>
                </div>
              );
            })()}
          </HkSettingsGroup>
          <HkSettingsGroup title={t("settings.cacheMirrorTitle")}>
            <HkSettingsHint>{t("settings.cacheMirrorHint")}</HkSettingsHint>
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  modelValue={mirrorDraft.value}
                  onUpdate:modelValue={(v: string) => (mirrorDraft.value = v)}
                  placeholder={t("settings.cacheMirrorPlaceholder")}
                  submitOnEnter={() => void saveMirror()}
                />
              </div>
              <HkButton size="sm" disabled={!mirrorDirty.value} onClick={() => void saveMirror()}>
                {mirrorSavedFlash.value
                  ? t("settings.networkSaved")
                  : t("settings.networkSave")}
              </HkButton>
            </div>
            <div class="settings-modal__mirror-presets">
              <button
                type="button"
                class="settings-modal__mirror-preset"
                onClick={() => (mirrorDraft.value = "")}
              >
                {t("settings.cacheMirrorDirect")}
              </button>
              {MIRROR_PRESETS.map((m) => (
                <button
                  type="button"
                  key={m}
                  class="settings-modal__mirror-preset"
                  onClick={() => (mirrorDraft.value = m)}
                >
                  {m.replace("https://", "")}
                </button>
              ))}
            </div>
          </HkSettingsGroup>
          <HkSettingsGroup title={t("settings.cacheAuxTitle")}>
            <HkSettingsHint>{t("settings.cacheAuxHint")}</HkSettingsHint>
            {cacheStore.auxCaches.map((c) => (
              <div class="settings-modal__pack" key={c.scope}>
                <div class="settings-modal__pack-info">
                  <span class="settings-modal__pack-name">{auxTitle(c.scope)}</span>
                  <span class="settings-modal__pack-desc">{auxDesc(c.scope)}</span>
                  <span class="settings-modal__pack-meta">{formatBytes(c.sizeBytes)}</span>
                </div>
                <div class="settings-modal__pack-actions">
                  {auxArmed.value === c.scope ? (
                    <HkButton
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        auxArmed.value = null;
                        void cacheStore.clearAuxCache(c.scope);
                      }}
                    >
                      {t("settings.cacheDeleteConfirm")}
                    </HkButton>
                  ) : (
                    <HkButton
                      variant="secondary"
                      size="sm"
                      disabled={c.sizeBytes === 0}
                      onClick={() => (auxArmed.value = c.scope)}
                    >
                      {t("settings.cacheAuxClear")}
                    </HkButton>
                  )}
                </div>
              </div>
            ))}
          </HkSettingsGroup>

          </>
          ),
          changelog: () => (
          <>
          {/* changelog — release notes streamed live from the project's
              GitHub Releases (the repo keeps no changelog file; the
              Releases page IS the history). One article per release,
              newest first, with a 当前 badge on the running build; the
              section activators above load the feed on demand and the
              component owns only the explicit refresh. */}
          <ChangelogSection />
          </>
          ),
          overlay: () => (
          <>
          {/* in-game overlay (Mode 2) — pre-creates the transparent window
              + Tab watcher while the game runs; hold Tab in battle to see
              per-player WR / avg damage over the team list. TWO independent
              switches (radio-style so a future "plugin" mode can join each
              later without schema churn): table anchoring pixel-detects the
              team table, and its off state disables the WHOLE Tab overlay;
              roster attribution picks the rule-inferred mapping (the
              default — no OCR at all), the OCR pipeline (exact; offered
              only when the OS engine is usable — a system with the OCR
              language pack stripped keeps the option visible but disabled),
              or the roster/index order fallback. The note under the first
              switch explains why exclusive fullscreen can't work.
              Unreachable on the phone app build (no overlay window there —
              the rail filters the section out). */}
          <HkSettingsGroup title={t("settings.overlay")}>
            <HkSettingsHint>{t("settings.overlayDesc")}</HkSettingsHint>
            <HkSettingsSub title={t("settings.overlayTable")}>
              <HkTabs
                block
                variant="segmented"
                modelValue={overlayCfg.table}
                onUpdate:modelValue={(v: string) => void overlayCfg.setTable(v as TableAnchorMode)}
                tabs={[
                  { key: "detect", label: t("settings.overlayTableDetect") },
                  { key: "off", label: t("settings.overlayTableOff") },
                ]}
              />
              <HkSettingsHint>{t("settings.overlayFullscreenNote")}</HkSettingsHint>
            </HkSettingsSub>
            <HkSettingsSub title={t("settings.overlayRoster")}>
              <HkTabs
                block
                variant="segmented"
                modelValue={overlayCfg.roster}
                onUpdate:modelValue={(v: string) =>
                  void overlayCfg.setRoster(v as RosterRecognitionMode)
                }
                tabs={[
                  { key: "inferred", label: t("settings.overlayRosterInferred") },
                  {
                    key: "ocr",
                    label: t("settings.overlayRosterOcr"),
                    disabled: !ocrAvailable.value,
                  },
                  { key: "off", label: t("settings.overlayRosterOff") },
                ]}
              />
              {!ocrAvailable.value ? (
                <HkSettingsHint>{t("settings.overlayRosterOcrUnavailable")}</HkSettingsHint>
              ) : null}
            </HkSettingsSub>
          </HkSettingsGroup>

          </>
          ),
          about: () => (
          <>
          {/* about */}
          <HkSettingsGroup title={t("settings.about")}>
            <AboutContent />
          </HkSettingsGroup>
          {/* usage-telemetry disclosure — its own group closing the section
              (moved out of the About notice card), rendered in the user's
              own language; the full notice lives at
              docs/{lang}/license/usage-telemetry.md. */}
          <HkSettingsGroup title={t("settings.telemetryTitle")}>
            <HkSettingsHint>
              {pickTelemetryNotice(lang.uiLocale.value).text}
            </HkSettingsHint>
          </HkSettingsGroup>
          </>
          ),
          attributions: () => (
          <>
          {/* attributions — partner + asset credits (seal calligraphy
              fonts, wallpaper art). The same AuthorMark component
              annotates the desktop wallpaper. */}
          <HkSettingsGroup title={t("settings.attributions")}>
            <HkSettingsHint>{t("settings.attributionsHint")}</HkSettingsHint>
            <div class="settings-modal__attributions">
              {ATTRIBUTIONS.map((a) => (
                <div key={a.id} class="settings-modal__attribution">
                  <AuthorMark name={a.name} url={a.url} role={t(`about.attribution.${a.roleKey}`)} />
                  {a.noteKey ? <HkSettingsHint>{t(`about.attribution.${a.noteKey}`)}</HkSettingsHint> : null}
                </div>
              ))}
            </div>
          </HkSettingsGroup>
          </>
          ),
          }}
        </HkSettingsBody>

        {/* DPI preview confirm — a pure view over dpiPrefs' app-level
            countdown store (all keep/revert logic lives there): it floats
            above whichever surface hosts the body while a preview is live,
            closing it via X/backdrop counts as Keep, "Revert now" restores
            the persisted value, and expiry reverts by itself. */}
        <HkModal
          modelValue={dpiCountdown.active}
          onUpdate:modelValue={(v: boolean) => {
            if (!v && dpiCountdown.active) onDpiKeep();
          }}
          title={t("settings.dpiConfirmTitle")}
          width="22rem"
          footerActions={dpiConfirmActions.value}
        >
          <HkSettingsHint>
            {t("settings.dpiRevertCountdown", {
              scale: dpiCountdown.scale,
              seconds: dpiCountdown.remaining,
            })}
          </HkSettingsHint>
        </HkModal>
        </>
      );
    };
  },
});
