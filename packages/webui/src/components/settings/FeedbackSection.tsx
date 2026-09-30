import { computed, defineComponent, onMounted, onUnmounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { Camera, Copy, ExternalLink, FolderSearch, History, PackageOpen } from "@lucide/vue";

import {
  HkButton,
  HkCheckbox,
  HkIconButton,
  HkInput,
  HkSelect,
  HkSettingsGroup,
  HkSettingsHint,
  HkSpinner,
  HkTag,
  HkTextarea,
  useToast,
} from "@celestia-island/hikari";

import { api, type LogsOverview } from "@/api";
import { useAccountStore } from "@/stores/account";
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
    const accounts = useAccountStore();
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

    /** The web form link carries the local build identity as prefill, and
     *  the UI locale so the form (and its privacy note) opens in the
     *  language the user already chose in the app. */
    const webFormUrl = computed(() => {
      const q = new URLSearchParams({
        version: version.value,
        sysinfo: `desktop ${navigator.platform || "unknown"}`,
        channel: "desktop",
        lang: lang.uiLocale.value,
      });
      // The active account prefills the form's server + game-ID row.
      const active = accounts.activeAccount;
      if (active) {
        q.set("server", active.realm);
        q.set("game_id", String(active.accountId));
      }
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
    // focus (the settings shell renders only the active slot) or when the
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

    // ── 内嵌表单 ────────────────────────────────────────────────────────
    const desc = ref("");
    const contact = ref("");
    const ctType = ref<"qq" | "email">("qq");
    const server = ref("");
    const gameId = ref("");
    const attachLogs = ref(false);
    const shot = ref<{ path: string; preview: string } | null>(null);
    const shooting = ref(false);
    const qqCode = ref("");
    const qqVerified = ref(false);
    const qqBusy = ref(false);
    const submitting = ref(false);
    const recordUrl = ref("");
    const formError = ref("");
    let qqTimer: ReturnType<typeof setInterval> | null = null;

    // Active account prefills the server + game-ID row (editable).
    const active = computed(() => accounts.activeAccount);
    onMounted(() => {
      if (active.value) {
        server.value = active.value.realm;
        gameId.value = String(active.value.accountId);
      }
    });

    const isQq = computed(() =>
      ctType.value === "qq" && /^\d{5,11}$/.test(contact.value.trim()));
    const errKey = computed(() => {
      if (!formError.value) return "";
      const map: Record<string, string> = {
        not_verified: "settings.feedbackErrNotVerified",
        rate_limited: "settings.feedbackErrRate",
        file_too_large: "settings.feedbackErrFile",
        empty_description: "settings.feedbackErrEmpty",
        unreachable: "settings.feedbackErrUnreachable",
      };
      return map[formError.value] || "settings.feedbackErrUpstream";
    });

    function stopQqPoll() {
      if (qqTimer) {
        clearInterval(qqTimer);
        qqTimer = null;
      }
    }

    async function pollQq() {
      if (!isQq.value) return;
      try {
        const r = await api.feedbackQqStatus(contact.value.trim());
        if (r.ok && r.verified) {
          qqVerified.value = true;
          stopQqPoll();
        }
      } catch {
        // Proxied call failed — the next tick retries.
      }
    }

    function watchContact() {
      qqVerified.value = false;
      qqCode.value = "";
      stopQqPoll();
      // Unambiguous input flips the category.
      const v = contact.value.trim();
      if (v.includes("@")) ctType.value = "email";
      else if (/^\d+$/.test(v) && v) ctType.value = "qq";
      if (isQq.value) {
        void pollQq();
        qqTimer = setInterval(() => void pollQq(), 5000);
      }
    }

    async function getQqCode() {
      if (!isQq.value) return;
      qqBusy.value = true;
      try {
        const r = await api.feedbackQqCode(contact.value.trim());
        if (r.ok) {
          qqCode.value = r.code;
          if (!qqTimer) qqTimer = setInterval(() => void pollQq(), 5000);
        }
      } catch (e) {
        toast.error((e as Error).message || String(e));
      } finally {
        qqBusy.value = false;
      }
    }

    async function takeShot() {
      shooting.value = true;
      try {
        shot.value = await api.feedbackShot();
      } catch (e) {
        toast.error(`${t("settings.feedbackShot")}\n${(e as Error).message || e}`);
      } finally {
        shooting.value = false;
      }
    }

    async function submitForm() {
      if (!desc.value.trim() || submitting.value) return;
      submitting.value = true;
      formError.value = "";
      recordUrl.value = "";
      try {
        const r = await api.feedbackSubmit({
          description: desc.value.trim(),
          contact: contact.value.trim(),
          server: server.value,
          gameId: gameId.value.trim(),
          version: version.value,
          screenshotPath: shot.value?.path ?? "",
          attachLogs: attachLogs.value,
        });
        recordUrl.value = r.record_url;
        toast.success(t("settings.feedbackSubmitted"));
        desc.value = "";
        shot.value = null;
        attachLogs.value = false;
      } catch (e) {
        formError.value = (e as Error).message || String(e);
      } finally {
        submitting.value = false;
      }
    }

    // The pane unmounts on section switch — clear the poll there.
    onUnmounted(stopQqPoll);

    const realmOptions = [
      { value: "", label: t("settings.feedbackServerNone") },
      ...["ru", "eu", "na", "asia", "cn"].map((r) => ({
        value: r,
        label: r.toUpperCase(),
      })),
    ];

    /** The web form's history panel, focused (the browser remembers the
     *  contact id in its own localStorage). Same lang handoff as the form
     *  link above. */
    function openHistory() {
      void openExternal(`${WEB_FORM_URL}?focus=history&lang=${lang.uiLocale.value}`);
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

      <HkSettingsGroup title={t("settings.feedbackForm")}>
        <HkSettingsHint>{t("settings.feedbackFormHint")}</HkSettingsHint>

        <div class="feedback__form">
          <label class="feedback__field-label">{t("settings.feedbackDesc")}</label>
          <HkTextarea
            modelValue={desc.value}
            onUpdate:modelValue={(v: string) => (desc.value = v)}
            placeholder={t("settings.feedbackDescPh")}
            rows={4}
            maxLength={5000}
          />

          <label class="feedback__field-label">{t("settings.feedbackContact")}</label>
          <div class="feedback__contact">
            <HkButton
              size="sm"
              variant={ctType.value === "qq" ? "primary" : "ghost"}
              onClick={() => {
                ctType.value = "qq";
                watchContact();
              }}
            >
              {t("settings.feedbackContactQq")}
            </HkButton>
            <HkButton
              size="sm"
              variant={ctType.value === "email" ? "primary" : "ghost"}
              onClick={() => {
                ctType.value = "email";
                watchContact();
              }}
            >
              {t("settings.feedbackContactEmail")}
            </HkButton>
            <HkInput
              modelValue={contact.value}
              onUpdate:modelValue={(v: string) => {
                contact.value = v;
                watchContact();
              }}
              placeholder={
                ctType.value === "qq"
                  ? t("settings.feedbackContactPhQq")
                  : t("settings.feedbackContactPhEmail")
              }
            />
          </div>

          {isQq.value && !qqVerified.value ? (
            <div class="feedback__qq-verify">
              <span>
                {qqCode.value
                  ? t("settings.feedbackQqVerifyCode").replace(/#c/g, qqCode.value)
                  : t("settings.feedbackQqVerifyHint")}
              </span>
              <HkButton
                size="sm"
                loading={qqBusy.value}
                disabled={qqBusy.value}
                onClick={() => void getQqCode()}
              >
                {t("settings.feedbackQqVerifyBtn")}
              </HkButton>
            </div>
          ) : isQq.value && qqVerified.value ? (
            <div class="feedback__qq-verify feedback__qq-verify--ok">
              <HkTag variant="success" size="sm">
                {t("settings.feedbackQqVerified")}
              </HkTag>
            </div>
          ) : null}

          <label class="feedback__field-label">
            {t("settings.feedbackServerGame")}
          </label>
          <div class="feedback__contact">
            <div class="feedback__server-select">
              <HkSelect
                modelValue={server.value}
                onUpdate:modelValue={(v: string) => (server.value = v)}
                options={realmOptions}
              />
            </div>
            <HkInput
              modelValue={gameId.value}
              onUpdate:modelValue={(v: string) => (gameId.value = v)}
              placeholder={t("settings.feedbackGameIdPh")}
            />
          </div>

          <div class="feedback__attach">
            <HkButton
              size="sm"
              loading={shooting.value}
              disabled={shooting.value}
              onClick={() => void takeShot()}
            >
              <Camera size={14} />
              {t("settings.feedbackShotAttach")}
            </HkButton>
            {shot.value ? (
              <div class="feedback__shot">
                <img
                  class="feedback__shot-preview"
                  src={`data:image/png;base64,${shot.value.preview}`}
                  alt=""
                />
                <HkButton
                  size="sm"
                  variant="ghost"
                  onClick={() => (shot.value = null)}
                >
                  {t("settings.feedbackShotRemove")}
                </HkButton>
              </div>
            ) : null}
            <HkCheckbox
              modelValue={attachLogs.value}
              onUpdate:modelValue={(v: boolean) => (attachLogs.value = v)}
            >
              {t("settings.feedbackAttachLogs")}
            </HkCheckbox>
          </div>

          {formError.value ? (
            <p class="feedback__error">{t(errKey.value)}</p>
          ) : null}
          {recordUrl.value ? (
            <p class="feedback__ok">
              {t("settings.feedbackSubmitted")}
              <a href={recordUrl.value} target="_blank" rel="noreferrer">
                {t("settings.feedbackViewRecord")}
              </a>
            </p>
          ) : null}

          <div class="feedback__actions">
            <HkButton
              variant="primary"
              size="sm"
              loading={submitting.value}
              disabled={submitting.value || !desc.value.trim()}
              onClick={() => void submitForm()}
            >
              {t("settings.feedbackSubmitBtn")}
            </HkButton>
          </div>
          <HkSettingsHint>{t("settings.feedbackPrivacy")}</HkSettingsHint>
        </div>

        <div class="feedback__actions">
          <HkButton size="sm" onClick={openHistory}>
            <History size={14} />
            {t("settings.feedbackHistoryBtn")}
          </HkButton>
          <HkButton size="sm" onClick={() => void openExternal(webFormUrl.value)}>
            <ExternalLink size={14} />
            {t("settings.feedbackWeb")}
          </HkButton>
          <HkButton size="sm" onClick={() => void openExternal(t("about.links.issues"))}>
            GitHub Issues
          </HkButton>
          <HkButton size="sm" onClick={() => void openExternal(t("about.links.qqGroup"))}>
            {t("settings.feedbackQqGroup")}
          </HkButton>
        </div>
      </HkSettingsGroup>
      </>
    );
  },
});
