import { computed, defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { Camera, Copy, ExternalLink, FolderSearch, History, PackageOpen } from "@lucide/vue";

import {
  HkButton,
  HkIconButton,
  HkSettingsGroup,
  HkSettingsHint,
  HkSpinner,
  useToast,
} from "@celestia-island/hikari";

import { api, type LogsOverview } from "@/api";
import { t, type Locale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useClipboard } from "@/composables/useClipboard";
import { openExternal } from "@/utils/openExternal";
import "./FeedbackSection.scss";

/** One Intl formatter per visited locale (same caching idiom as
 *  ChangelogSection — re-rendering on locale switch is fine, re-parsing
 *  the formatter per row is not). */
const dateTimeFormatters = new Map<Locale, Intl.DateTimeFormat>();

function formatDateTime(locale: Locale, iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let fmt = dateTimeFormatters.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    dateTimeFormatters.set(locale, fmt);
  }
  return fmt.format(date);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Round at display precision, then bump the unit at the boundary — a
  // 1023.99 KiB file must read "1.0 MB", never "1024 KB".
  let text = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  if (text >= 1024 && unit < units.length - 1) {
    text = 1;
    unit += 1;
  }
  return `${text} ${units[unit]}`;
}

/**
 * FeedbackSection — the settings' 问题反馈 pane. The app keeps a
 * daily-rolling UTF-8 diagnostics log (Rust `logging` module, under
 * `<data>/logs`); this pane surfaces it locally (reveal the newest file,
 * copy the tail, export a zip bundle) and hands off to the web feedback
 * form (wowsp.langyo.xyz/feedback, Turnstile-protected) whose submissions
 * land in the 飞书多维表 review pipeline — export the bundle first, then
 * attach it in the form.
 */
const WEB_FORM_URL = "https://wowsp.langyo.xyz/feedback";

export default defineComponent({
  name: "FeedbackSection",
  setup() {
    const toast = useToast();
    const lang = useLanguage();
    const { copy } = useClipboard();

    const version = ref("");
    onMounted(async () => {
      // Running build, for the web form's prefilled version field
      // (browser dev keeps "" — the form just shows an empty field).
      try {
        version.value = await getVersion();
      } catch {
        // Browser dev mode — no Tauri runtime.
      }
    });

    /** The web form link carries the local build identity as prefill. */
    const webFormUrl = computed(() => {
      const q = new URLSearchParams({
        version: version.value,
        sysinfo: `desktop ${navigator.platform || "unknown"}`,
        channel: "desktop",
      });
      return `${WEB_FORM_URL}?${q.toString()}`;
    });

    const overview = ref<LogsOverview | null>(null);
    // Starts true: mount always kicks a load onMounted, so the first render
    // already shows the spinner instead of flashing the error block.
    const loading = ref(true);
    const error = ref("");
    const revealing = ref(false);
    const copying = ref(false);
    const exporting = ref(false);

    async function refresh() {
      loading.value = true;
      error.value = "";
      try {
        overview.value = await api.logsOverview();
      } catch (e) {
        error.value = (e as Error).message || String(e);
      } finally {
        loading.value = false;
      }
    }

    // Fresh read on every entry: the pane unmounts when its section loses
    // focus (HkSettingsBody renders only the active slot) or when the
    // settings surface closes, so mount IS the reopen event — sizes and
    // file counts drift while the app runs.
    onMounted(() => void refresh());

    const latest = computed(() => overview.value?.latest ?? null);
    const retainedCount = computed(() => (overview.value?.files.length ?? 0) + (latest.value ? 1 : 0));

    async function revealLatest() {
      revealing.value = true;
      try {
        await api.logsRevealLatest();
      } catch (e) {
        toast.error(`${t("settings.feedbackReveal")}\n${(e as Error).message || e}`);
      } finally {
        revealing.value = false;
      }
    }

    async function copyTail() {
      copying.value = true;
      try {
        const tail = await api.logsReadTail();
        await copy(tail);
      } catch (e) {
        toast.error(`${t("settings.feedbackCopyTail")}\n${(e as Error).message || e}`);
      } finally {
        copying.value = false;
      }
    }

    async function exportBundle() {
      exporting.value = true;
      try {
        const path = await api.logsExportBundle();
        toast.success(`${t("settings.feedbackExported")}\n${path}`);
      } catch (e) {
        toast.error(`${t("settings.feedbackExport")}\n${(e as Error).message || e}`);
      } finally {
        exporting.value = false;
      }
    }

    const capturing = ref(false);

    /** 全屏截图 quick action: capture → reveal → the user attaches the
     *  revealed PNG in the web form (same pattern as the log bundle). */
    async function captureScreen() {
      capturing.value = true;
      try {
        const path = await api.feedbackCaptureScreen();
        toast.success(`${t("settings.feedbackShotDone")}\n${path}`);
      } catch (e) {
        toast.error(`${t("settings.feedbackShot")}\n${(e as Error).message || e}`);
      } finally {
        capturing.value = false;
      }
    }

    /** The web form's history panel, focused (the browser remembers the
     *  contact id in its own localStorage). */
    function openHistory() {
      void openExternal(`${WEB_FORM_URL}?focus=history`);
    }

    return () => (
      <>
      <HkSettingsGroup>
        <div class="settings-modal__packs-head">
          <h2 class="hk-settings-group-title">{t("settings.feedback")}</h2>
          <HkButton
            size="sm"
            loading={loading.value}
            disabled={loading.value}
            onClick={() => void refresh()}
          >
            {t("settings.feedbackRefresh")}
          </HkButton>
        </div>
        <HkSettingsHint>{t("settings.feedbackHint")}</HkSettingsHint>

        {loading.value && !overview.value ? (
          <div class="feedback__state">
            <HkSpinner size="sm" />
            <span class="feedback__state-text">{t("settings.feedbackLoading")}</span>
          </div>
        ) : !overview.value ? (
          <div class="feedback__state">
            <p class="feedback__error">{t("settings.feedbackFailed")}</p>
            <HkButton size="sm" onClick={() => void refresh()}>{t("common.retry")}</HkButton>
          </div>
        ) : !latest.value ? (
          <p class="feedback__empty">{t("settings.feedbackNoLogs")}</p>
        ) : (
          <>
          {/* A failed refresh keeps the stale card on screen — the error
              line rides above it instead of blanking the pane. */}
          {error.value ? (
            <p class="feedback__error">{t("settings.feedbackFailed")}</p>
          ) : null}
          <div class="feedback__card">
            <div class="feedback__row">
              <span class="feedback__label">{t("settings.feedbackLatestLog")}</span>
              <span class="feedback__file">{latest.value.name}</span>
              <span class="feedback__meta">
                {formatBytes(latest.value.sizeBytes)}
                {formatDateTime(lang.uiLocale.value, latest.value.modified)
                  ? ` · ${formatDateTime(lang.uiLocale.value, latest.value.modified)}`
                  : ""}
              </span>
            </div>
            <div class="feedback__row">
              <span class="feedback__label">{t("settings.feedbackLogDir")}</span>
              <span class="feedback__dir" title={overview.value?.dir}>
                {overview.value?.dir}
              </span>
              <HkIconButton
                size={24}
                variant="ghost"
                aria-label={t("common.clickToCopy")}
                onClick={() => void copy(overview.value?.dir ?? "")}
              >
                <Copy size={14} />
              </HkIconButton>
            </div>
            <p class="feedback__note">
              {t("settings.feedbackRetained", {
                count: String(retainedCount.value),
                size: formatBytes(overview.value?.totalBytes ?? 0),
                max: String(overview.value?.retainedMax ?? 0),
              })}
            </p>
          </div>
          </>
        )}

        <div class="feedback__actions">
          <HkButton
            variant="primary"
            size="sm"
            loading={revealing.value}
            disabled={revealing.value || !latest.value}
            onClick={() => void revealLatest()}
          >
            <FolderSearch size={14} />
            {t("settings.feedbackReveal")}
          </HkButton>
          <HkButton
            size="sm"
            loading={copying.value}
            disabled={copying.value || !latest.value}
            onClick={() => void copyTail()}
          >
            {t("settings.feedbackCopyTail")}
          </HkButton>
          <HkButton
            size="sm"
            loading={exporting.value}
            disabled={exporting.value || !latest.value}
            onClick={() => void exportBundle()}
          >
            <PackageOpen size={14} />
            {t("settings.feedbackExport")}
          </HkButton>
        </div>
      </HkSettingsGroup>

      <HkSettingsGroup title={t("settings.feedbackChannels")}>
        <HkSettingsHint>{t("settings.feedbackChannelsHint")}</HkSettingsHint>
        <div class="feedback__actions">
          <HkButton
            variant="primary"
            size="sm"
            onClick={() => void openExternal(webFormUrl.value)}
          >
            <ExternalLink size={14} />
            {t("settings.feedbackWeb")}
          </HkButton>
          <HkButton
            size="sm"
            loading={capturing.value}
            disabled={capturing.value}
            onClick={() => void captureScreen()}
          >
            <Camera size={14} />
            {t("settings.feedbackShot")}
          </HkButton>
          <HkButton size="sm" onClick={openHistory}>
            <History size={14} />
            {t("settings.feedbackHistoryBtn")}
          </HkButton>
          <HkButton size="sm" onClick={() => void openExternal(t("about.links.issues"))}>
            GitHub Issues
          </HkButton>
          <HkButton size="sm" onClick={() => void openExternal(t("about.links.qqGroup"))}>
            {t("settings.feedbackQqGroup")}
          </HkButton>
        </div>
        <HkSettingsHint>{t("settings.feedbackWebHint")}</HkSettingsHint>
        <HkSettingsHint>{t("settings.feedbackPrivacy")}</HkSettingsHint>
      </HkSettingsGroup>
      </>
    );
  },
});
