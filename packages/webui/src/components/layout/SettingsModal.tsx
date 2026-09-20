import { computed, defineComponent, onMounted, ref, watch } from "vue";
import {
  BarChart3,
  Check,
  Copyright,
  Database,
  FolderCog,
  FolderOpen,
  Globe,
  Info,
  Languages,
  Layers,
  Monitor,
  MonitorPlay,
  Moon,
  Palette,
  RefreshCw,
  Sun,
  SunMoon,
  UserRound,
} from "@lucide/vue";

import {
  HButton,
  HInput,
  HModal,
  HSelect,
  HTabs,
  HTag,
  getThemeTokens,
  themePresets,
  useTheme,
  useToast,
} from "@celestia-island/hikari";

import { useWallpaper } from "@/theme/useWallpaper";
import {
  setThemeModePreference,
  themeModePreference,
  type ThemeModePreference,
} from "@/theme/themeModePreference";
import { t, type Locale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { api, type GameInstall, type NetworkConfig } from "@/api";
import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import {
  useOverlayConfigStore,
  type RosterRecognitionMode,
  type TableAnchorMode,
} from "@/stores/overlayConfig";
import { useSettingsUiStore, type SettingsSection } from "@/stores/settingsUi";
import { useCacheStore, type PackId } from "@/stores/cache";
import { AboutContent } from "@/components/layout/AboutModal";
import AccountManagerContent from "@/components/account/AccountManagerContent";
import RealmFlag from "@/components/base/RealmFlag";
import AuthorMark from "@/components/base/AuthorMark";
import StatsPrefsControls from "@/components/stats/StatsPrefsControls";
import { ATTRIBUTIONS } from "@/data/attributions";
import { kindLabel } from "@/utils/installLabel";
import "./SettingsModal.scss";

/** Hikari token → CSS rgb() color. */
function css(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

// Brand default first, then hikari's built-ins (incl. the shared
// nord/gruvbox/tokyonight presets and any user custom themes).
const presetIds = Object.keys(themePresets).sort((a, b) =>
  a === "ocean" ? -1 : b === "ocean" ? 1 : 0,
);

/**
 * Settings modal (app-singleton, driven by the settingsUi store — the
 * title-bar gear and the sidebar's client / account buttons all open it,
 * optionally landing on a section): language, appearance (theme mode +
 * color preset + wallpaper + solar indicator), game path (ALL known
 * installs as rich cards with a realm flag — click to activate), account
 * management, network proxy, and About. Sections live in titled cards
 * stacked in the modal body; every control rows up with its card so
 * nothing floats mid-air.
 *
 * The solar line under Appearance shows the current sun-based classification
 * so users understand what "Auto (sun)" does.
 */
export default defineComponent({
  name: "SettingsModal",
  setup() {
    const ui = useSettingsUiStore();
    const theme = useTheme();
    const wallpaper = useWallpaper();
    const lang = useLanguage();
    const overlayCfg = useOverlayConfigStore();
    const configStore = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const toast = useToast();

    // ── game-path table (see the 游戏路径 section) ────────────────────────
    const pickingPath = ref(false);

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

    /** Native folder picker → validate → pin as the active install. */
    async function browseFolder() {
      if (pickingPath.value) return;
      pickingPath.value = true;
      try {
        // Null = the user closed the native dialog — not an error.
        const picked = await api.pickGameFolder();
        if (!picked) return;
        await configStore.setManualPath(picked.path);
        await followRealm(picked.realm);
        toast.info(t("common.gamePath.applied"));
      } catch (e) {
        toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || e}`);
      } finally {
        pickingPath.value = false;
      }
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
        proxy: netCfg.value.proxy?.trim() || null,
        resourceCdn: netCfg.value.resourceCdn?.trim() || null,
      };
      delete payload.effectiveProxy;
      try {
        await api.setNetworkConfig(payload);
        netCfg.value = { ...payload };
        netLastSaved.value = { ...payload };
        netSavedFlash.value = true;
        window.clearTimeout(netFlashTimer);
        netFlashTimer = window.setTimeout(() => (netSavedFlash.value = false), 1600);
      } catch {
        // best-effort — the desktop shell persists it; mock has no backend
      }
    }

    // ── Cache management (resource packs + mirror + aux caches) ──────────
    const cacheStore = useCacheStore();
    /** Mirror input draft; commits through the cache store (which spreads
     *  the rest of the network config). */
    const mirrorDraft = ref("");
    const mirrorSavedFlash = ref(false);
    let mirrorFlashTimer: number | undefined;
    /** Two-step delete confirm per pack (id of the armed row). */
    const clearArmed = ref<string | null>(null);
    /** Two-step aux-cache clear confirm (scope of the armed row). */
    const auxArmed = ref<string | null>(null);
    /** Common ghproxy presets — click to fill the input. */
    const MIRROR_PRESETS = [
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
        if (id !== "cache") return;
        void cacheStore.refreshStatus();
        void cacheStore.loadMirror().then(() => {
          mirrorDraft.value = cacheStore.githubMirror ?? "";
        });
        if (!cacheStore.updatesCheckedAt) void cacheStore.refreshUpdates();
      },
    );

    // The modal stays mounted, so reopening it while still on the cache
    // section would show stale sizes/versions — refresh on open too.
    watch(
      () => ui.visible,
      (open) => {
        if (open && ui.section === "cache") {
          void cacheStore.refreshStatus();
          void cacheStore.refreshUpdates();
        }
      },
    );

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

    function packTitle(id: PackId): string {
      return id === "models"
        ? t("settings.cachePackModels")
        : t("settings.cachePackDogtags");
    }

    function packDesc(id: PackId): string {
      return id === "models"
        ? t("settings.cachePackModelsDesc")
        : t("settings.cachePackDogtagsDesc");
    }

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

    // ── section rail ────────────────────────────────────────────────────────
    // The left rail mirrors the main sidebar's nav look; only the active
    // section's card renders in the content pane. Section identity lives in
    // the settingsUi store so openers can land on a specific one.
    const SECTION_ICONS = {
      language: Languages,
      appearance: Palette,
      stats: BarChart3,
      gamePath: FolderCog,
      account: UserRound,
      network: Globe,
      cache: Database,
      overlay: Layers,
      about: Info,
      attributions: Copyright,
    };
    const sectionLabels = computed<Record<SettingsSection, string>>(() => ({
      language: t("settings.language"),
      appearance: t("settings.themeMode"),
      stats: t("settings.statsSection"),
      gamePath: t("settings.gamePath"),
      account: t("settings.account"),
      network: t("settings.network"),
      cache: t("settings.cache"),
      overlay: t("settings.overlay"),
      about: t("settings.about"),
      attributions: t("settings.attributions"),
    }));
    const sections = computed(() => Object.keys(sectionLabels.value) as SettingsSection[]);

    return () => (
      <HModal
        modelValue={ui.visible}
        onUpdate:modelValue={(v: boolean) => (v ? ui.show() : ui.hide())}
        title={t("settings.title")}
        width="58rem"
      >
        <div class="settings-modal">
          {/* section rail — same visual language as the main sidebar's nav */}
          <nav class="settings-modal__rail">
            {sections.value.map((id) => {
              const Icon = SECTION_ICONS[id];
              return (
                <button
                  key={id}
                  type="button"
                  class={["settings-modal__rail-item", ui.section === id ? "is-active" : ""]}
                  onClick={() => (ui.section = id)}
                >
                  <span class="settings-modal__rail-icon">
                    <Icon size={16} />
                  </span>
                  <span>{sectionLabels.value[id]}</span>
                </button>
              );
            })}
          </nav>

          <div class="settings-modal__pane">
          {ui.section === "language" ? (
          <>
          {/* language — two independent dropdowns: UI (app interface) vs data
              (game-asset names: ships/captains/maps). The same language can have
              different official translations across regions, e.g. 国服 simplified
              (animal names for IJN) vs 亚服 Chinese. */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.language")}</h2>
            <div class="settings-modal__langs">
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.uiLanguage")}</span>
                <HSelect
                  modelValue={lang.uiLocale.value}
                  onUpdate:modelValue={(v: string) => lang.setUiLocale(v as Locale)}
                  options={lang.uiLocaleOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.dataLanguage")}</span>
                <HSelect
                  modelValue={lang.dataLanguage.value}
                  onUpdate:modelValue={(v: string) => lang.setDataLanguage(v)}
                  options={lang.wgLanguageOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>
            <p class="settings-modal__hint">{t("settings.dataLanguageHint")}</p>
          </section>

          </>
          ) : null}
          {ui.section === "appearance" ? (
          <>
          {/* appearance — mode, color preset, wallpaper, solar indicator */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.themeMode")}</h2>
            {/* Four-way mode preference (wowsp's own key — see
                theme/themeModePreference): dark/light verbatim, solar =
                daylight-following (hikari "system"), system = OS
                prefers-color-scheme. Selection applies immediately. */}
            <HTabs
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
                { key: "system", label: t("settings.themeModeSystem"), icon: <Monitor size={14} /> },
              ]}
            />

            {/* color preset — uniform card chrome; the theme only peeks
                through the preview chip so the row reads as one control */}
            <div class="settings-modal__sub">
              <h3 class="settings-modal__sub-title">{t("settings.themePreset")}</h3>
              <div class="settings-modal__presets">
                {presetIds.map((id) => {
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
            </div>

            {/* wallpaper / background */}
            <div class="settings-modal__sub">
              <h3 class="settings-modal__sub-title">{t("settings.wallpaper")}</h3>
              <div class="settings-modal__wallpapers">
                {wallpaper.allWallpapers.value.map((w) => {
                  const on = wallpaper.activeWallpaperId.value === w.id;
                  return (
                    <button
                      type="button"
                      aria-pressed={on}
                      class={["settings-modal__wallpaper", on ? "settings-modal__wallpaper--on" : ""]}
                      onClick={() => wallpaper.setActiveWallpaper(w.id)}
                    >
                      <span class="settings-modal__wallpaper-preview">
                        {w.source.type === "solid" ? (
                          <span
                            class="settings-modal__wallpaper-swatch"
                            style={{
                              background:
                                w.source.color === "black"
                                  ? "#0b1220"
                                  : w.source.color === "white"
                                    ? "#f8fafc"
                                    : "linear-gradient(135deg, #0b1220 50%, #f8fafc 50%)",
                            }}
                          />
                        ) : (
                          <span
                            class="settings-modal__wallpaper-swatch settings-modal__wallpaper-swatch--image"
                            style={{ backgroundImage: `url(${w.source.url})` }}
                          />
                        )}
                      </span>
                      <span class="settings-modal__wallpaper-name">{w.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

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
            <p class="settings-modal__hint">{t("settings.geolocationHint")}</p>
          </section>

          </>
          ) : null}
          {ui.section === "stats" ? (
          <>
          {/* 战绩 (water-table prefs) — the same four controls as the
              onboarding wizard's preferences step (StatsPrefsControls),
              reading/writing the shared statsPrefs store. */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.statsSection")}</h2>
            <p class="settings-modal__hint">{t("settings.statsSectionHint")}</p>
            <StatsPrefsControls ns="settings" />
          </section>

          </>
          ) : null}
          {ui.section === "gamePath" ? (
          <>
          {/* game path — every known install (detected clients + manual pins)
              as a rich card mirroring the 账户 list: realm flag on the left,
              client + realm tag + path in the body; clicking a card
              activates it, which switches the app-wide client context
              (replay list, armor/ballistics loader, stats realm) and follows
              that realm's preferred account. Detection and the native
              folder picker live here too. */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.gamePath")}</h2>
            <p class="settings-modal__hint">{t("common.gamePath.desc")}</p>
            {installRows.value.length === 0 ? (
              <p class="settings-modal__hint">{t("common.gamePath.noneFound")}</p>
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
                      <RealmFlag realm={i.realm} kind={i.kind} />
                      <span class="install-card__body">
                        <span class="install-card__head">
                          <span class="install-card__name">{kindLabel(i.kind)}</span>
                          {i.realm ? (
                            <HTag variant="default" size="sm">{i.realm.toUpperCase()}</HTag>
                          ) : null}
                          {active ? <Check size={12} class="install-card__check" /> : null}
                        </span>
                        <span class="install-card__path" title={i.path}>{i.path}</span>
                      </span>
                      {active ? (
                        <HTag variant="success" size="sm">{t("common.gamePath.inUse")}</HTag>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
            {runningInstall.value ? (
              <div class="settings-modal__running">
                <MonitorPlay size={14} />
                <span class="settings-modal__hint">
                  {t("common.gamePath.runningHint", { path: runningInstall.value.path })}
                </span>
                <HButton size="sm" variant="secondary" onClick={() => void useRunning()}>
                  {t("common.gamePath.useRunning")}
                </HButton>
              </div>
            ) : null}
            <div class="settings-modal__install-actions">
              <HButton
                variant="secondary"
                loading={detecting.value}
                onClick={() => void configStore.detect()}
              >
                <RefreshCw size={14} /> {t("common.gamePath.redetect")}
              </HButton>
              <HButton variant="secondary" loading={pickingPath.value} onClick={() => void browseFolder()}>
                <FolderOpen size={14} /> {t("common.gamePath.browse")}
              </HButton>
            </div>
          </section>

          </>
          ) : null}
          {ui.section === "account" ? (
          <>
          {/* account — the binder/switcher body shared with the dashboard's
              modal entry: search → bind, rich cards for every bound account,
              click to activate. Switching here leaves the modal open (the
              wrapper modal closes instead). */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.account")}</h2>
            <p class="settings-modal__hint">{t("settings.accountHint")}</p>
            <AccountManagerContent />
          </section>
          </>
          ) : null}
          {ui.section === "network" ? (
          <>
          {/* network proxy — applies to every outbound request (stats, model
              pack, updates); resource CDN mirrors remote resources
              independently of the proxy mode */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.network")}</h2>
            <p class="settings-modal__hint">{t("settings.networkHint")}</p>
            <HTabs
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
                <HInput
                  modelValue={netCfg.value.proxy ?? ""}
                  onUpdate:modelValue={(v: string) => (netCfg.value.proxy = v)}
                  placeholder={t("settings.networkProxyPlaceholder")}
                  disabled={netCfg.value.mode !== "manual"}
                  submitOnEnter={() => void saveNet()}
                />
              </div>
              <HButton size="sm" disabled={!netDirty.value} onClick={() => void saveNet()}>
                {netSavedFlash.value ? t("settings.networkSaved") : t("settings.networkSave")}
              </HButton>
            </div>
            {/* Resource CDN — an independent setting, not gated on the proxy
                mode; commits via 保存 / Enter like the proxy URL. */}
            <div class="settings-modal__netinput">
              <HInput
                modelValue={netCfg.value.resourceCdn ?? ""}
                onUpdate:modelValue={(v: string) => (netCfg.value.resourceCdn = v)}
                placeholder={t("settings.resourceCdnPlaceholder")}
                submitOnEnter={() => void saveNet()}
              />
            </div>
            <p class="settings-modal__hint">{t("settings.resourceCdnHint")}</p>
          </section>

          </>
          ) : null}
          {ui.section === "cache" ? (
          <>
          {/* cache management — resource packs (download / update / delete
              with live progress), the GitHub mirror source for mainland
              networks, and clearable auxiliary caches. Pack sync versions
              are the GitHub release asset's updated_at stamp; an outdated
              pack shows an update banner instead of silently re-downloading
              gigabytes at startup. */}
          <section class="settings-modal__group">
            <div class="settings-modal__packs-head">
              <h2 class="settings-modal__group-title">{t("settings.cachePacksTitle")}</h2>
              <HButton
                size="sm"
                loading={cacheStore.updatesLoading}
                onClick={() => void cacheStore.refreshUpdates()}
              >
                {t("settings.cacheCheckUpdates")}
              </HButton>
            </div>
            <p class="settings-modal__hint">{t("settings.cachePacksHint")}</p>
            {cacheStore.anyUpdateAvailable ? (
              <p class="settings-modal__packs-banner">{t("settings.cacheUpdateBanner")}</p>
            ) : null}
            {(["models", "dogtags"] as PackId[]).map((id) => {
              const st = cacheStore.pack(id);
              const upd = cacheStore.updateOf(id);
              const prog = cacheStore.progress[id];
              const downloading =
                (st?.downloading ?? false) ||
                (prog != null && (prog.phase === "download" || prog.phase === "extract"));
              const pct =
                prog && prog.phase === "download" && prog.total > 0
                  ? Math.min(100, Math.round((prog.received / prog.total) * 100))
                  : 0;
              return (
                <div class="settings-modal__pack" key={id}>
                  <div class="settings-modal__pack-info">
                    <span class="settings-modal__pack-name">{packTitle(id)}</span>
                    <span class="settings-modal__pack-desc">{packDesc(id)}</span>
                    <span class="settings-modal__pack-meta">
                      {st?.present ? formatBytes(st.sizeBytes) : t("settings.cacheStatusMissing")}
                      {" · "}
                      {t("settings.cacheVersionLabel")}
                      {": "}
                      {formatStamp(st?.version)}
                      {upd?.updateAvailable && !downloading ? (
                        <span class="settings-modal__pack-update">
                          {t("settings.cacheUpdateAvailable")}
                        </span>
                      ) : null}
                    </span>
                    {downloading ? (
                      <div class="settings-modal__pack-progress">
                        <div
                          class="settings-modal__pack-progress-fill"
                          style={{ width: prog?.phase === "extract" ? "100%" : `${pct}%` }}
                        />
                      </div>
                    ) : null}
                    {prog?.phase === "error" && prog.error ? (
                      <span class="settings-modal__pack-error">
                        {t("settings.cacheDownloadFailed")}: {prog.error}
                      </span>
                    ) : null}
                  </div>
                  <div class="settings-modal__pack-actions">
                    {downloading ? (
                      <HButton size="sm" onClick={() => void cacheStore.cancel()}>
                        {prog?.phase === "extract"
                          ? t("settings.cacheExtracting")
                          : t("settings.cacheCancel")}
                      </HButton>
                    ) : st?.present ? (
                      <>
                        <HButton
                          variant="primary"
                          size="sm"
                          disabled={upd == null || !upd.updateAvailable}
                          onClick={() => void cacheStore.download(id)}
                        >
                          {t("settings.cacheUpdate")}
                        </HButton>
                        {clearArmed.value === id ? (
                          <HButton
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              clearArmed.value = null;
                              void cacheStore.clearPack(id);
                            }}
                          >
                            {t("settings.cacheDeleteConfirm")}
                          </HButton>
                        ) : (
                          <HButton
                            variant="secondary"
                            size="sm"
                            onClick={() => (clearArmed.value = id)}
                          >
                            {t("settings.cacheDelete")}
                          </HButton>
                        )}
                      </>
                    ) : (
                      <HButton
                        variant="primary"
                        size="sm"
                        onClick={() => void cacheStore.download(id)}
                      >
                        {t("settings.cacheDownload")}
                      </HButton>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.cacheMirrorTitle")}</h2>
            <p class="settings-modal__hint">{t("settings.cacheMirrorHint")}</p>
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HInput
                  modelValue={mirrorDraft.value}
                  onUpdate:modelValue={(v: string) => (mirrorDraft.value = v)}
                  placeholder={t("settings.cacheMirrorPlaceholder")}
                  submitOnEnter={() => void saveMirror()}
                />
              </div>
              <HButton size="sm" disabled={!mirrorDirty.value} onClick={() => void saveMirror()}>
                {mirrorSavedFlash.value
                  ? t("settings.networkSaved")
                  : t("settings.networkSave")}
              </HButton>
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
          </section>
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.cacheAuxTitle")}</h2>
            <p class="settings-modal__hint">{t("settings.cacheAuxHint")}</p>
            {cacheStore.auxCaches.map((c) => (
              <div class="settings-modal__pack" key={c.scope}>
                <div class="settings-modal__pack-info">
                  <span class="settings-modal__pack-name">{auxTitle(c.scope)}</span>
                  <span class="settings-modal__pack-desc">{auxDesc(c.scope)}</span>
                  <span class="settings-modal__pack-meta">{formatBytes(c.sizeBytes)}</span>
                </div>
                <div class="settings-modal__pack-actions">
                  {auxArmed.value === c.scope ? (
                    <HButton
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        auxArmed.value = null;
                        void cacheStore.clearAuxCache(c.scope);
                      }}
                    >
                      {t("settings.cacheDeleteConfirm")}
                    </HButton>
                  ) : (
                    <HButton
                      variant="secondary"
                      size="sm"
                      disabled={c.sizeBytes === 0}
                      onClick={() => (auxArmed.value = c.scope)}
                    >
                      {t("settings.cacheAuxClear")}
                    </HButton>
                  )}
                </div>
              </div>
            ))}
          </section>

          </>
          ) : null}
          {ui.section === "overlay" ? (
          <>
          {/* in-game overlay (Mode 2) — pre-creates the transparent window
              + Tab watcher while the game runs; hold Tab in battle to see
              per-player WR / avg damage over the team list. TWO independent
              switches (radio-style so a future "plugin" mode can join each
              later without schema churn): table anchoring pixel-detects the
              team table, and its off state disables the WHOLE Tab overlay;
              roster recognition picks OCR row→name matching or falls back
              to the roster/index order with no pending hints. The note
              under the first switch explains why exclusive fullscreen
              can't work. */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.overlay")}</h2>
            <p class="settings-modal__hint">{t("settings.overlayDesc")}</p>
            <div class="settings-modal__sub">
              <h3 class="settings-modal__sub-title">{t("settings.overlayTable")}</h3>
              <HTabs
                block
                variant="segmented"
                modelValue={overlayCfg.table}
                onUpdate:modelValue={(v: string) => void overlayCfg.setTable(v as TableAnchorMode)}
                tabs={[
                  { key: "detect", label: t("settings.overlayTableDetect") },
                  { key: "off", label: t("settings.overlayTableOff") },
                ]}
              />
              <p class="settings-modal__hint">{t("settings.overlayFullscreenNote")}</p>
            </div>
            <div class="settings-modal__sub">
              <h3 class="settings-modal__sub-title">{t("settings.overlayRoster")}</h3>
              <HTabs
                block
                variant="segmented"
                modelValue={overlayCfg.roster}
                onUpdate:modelValue={(v: string) =>
                  void overlayCfg.setRoster(v as RosterRecognitionMode)
                }
                tabs={[
                  { key: "ocr", label: t("settings.overlayRosterOcr") },
                  { key: "off", label: t("settings.overlayRosterOff") },
                ]}
              />
            </div>
          </section>

          </>
          ) : null}
          {ui.section === "about" ? (
          <>
          {/* about */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.about")}</h2>
            <AboutContent />
          </section>
          </>
          ) : null}
          {/* attributions — partner + asset credits (seal calligraphy fonts,
              wallpaper art). The same AuthorMark component annotates the
              desktop wallpaper. */}
          {ui.section === "attributions" ? (
          <>
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.attributions")}</h2>
            <p class="settings-modal__hint">{t("settings.attributionsHint")}</p>
            <div class="settings-modal__attributions">
              {ATTRIBUTIONS.map((a) => (
                <div key={a.id} class="settings-modal__attribution">
                  <AuthorMark name={a.name} url={a.url} role={t(`about.attribution.${a.roleKey}`)} />
                  {a.noteKey ? <p class="settings-modal__hint">{t(`about.attribution.${a.noteKey}`)}</p> : null}
                </div>
              ))}
            </div>
          </section>
          </>
          ) : null}
          </div>
        </div>
      </HModal>
    );
  },
});
