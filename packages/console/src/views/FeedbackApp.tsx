/**
 * FeedbackApp — the /feedback console page, parity port of the retired
 * server-rendered embedded page (spec: its HTML/JS lived in
 * packages/pairing-relay/crates/relay-core/src/feedback.rs until the
 * hikari rebuild removed it — commit 2e0f9b16, parent revision for the
 * exact source).
 *
 * Layout: the ORIGINAL two-pane shell on hikari components — one glass
 * card (HkCard) centered on the page, HSidebar docked left (brand /
 * view nav / language picker in its header/body/footer slots), the
 * active view scrolling right (HkScrollContainer). Panes stack below
 * 48rem. The rest is wiring only:
 * - boot handoff: ?focus=history (the desktop app's 历史记录 button) or
 *   ?token= lands on the history view, the query token outranks the
 *   saved credential, and an available token auto-loads the list —
 *   plus ?lang= in the locale detection (shared/i18n.ts), all restored
 *   parity the port had dropped;
 * - form: description / contact (QQ|email) / version (config prefill) /
 *   sysinfo+channel+server+game_id query prefill / attachment preview;
 * - HkCaptchaWidget (Turnstile sitekey from getFeedbackConfig); a failed
 *   submit bumps `attempt` so the widget mints a fresh token;
 * - submit success reveals the ONE-TIME lookup_token (audit M-7) via
 *   HkCopyBadge, links the Bitable record, and persists the credential to
 *   the same localStorage keys the embedded page used (wowsp_fb_token,
 *   wowsp_fb_token:<contact>) so the history view auto-fills;
 * - history view renders getFeedbackHistory rows — the worker handler
 *   (relay-worker/src/feedback.rs handle_history) answers
 *   `{ ok: true, items: [{ time: number|null, status: string,
 *   description: ≤120-char snippet, pr: string|null }] }`, an empty list
 *   for an unknown token.
 */
import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  HkButton,
  HkCard,
  HkCaptchaWidget,
  HkCopyBadge,
  HkErrorLanding,
  HkImagePreview,
  HkJsonTree,
  HkInput,
  HkNavItem,
  HkScrollContainer,
  HkSelect,
  HSidebar,
  HkSpinner,
  HkTextarea,
  HkToast,
  useBreakpoint,
  useToast,
} from "@celestia-island/hikari";
import { ExternalLink, History, MessageSquareText, Paperclip, X } from "@lucide/vue";

import {
  getFeedbackConfig,
  getFeedbackHistory,
  submitFeedback,
  type FeedbackConfig,
} from "@/shared/api";
import { FEEDBACK_LOCALES } from "@/shared/i18n";
import "./FeedbackApp.scss";

/** One getFeedbackHistory row (worker handle_history shape, see above). */
interface HistoryItem {
  time: number | null;
  status: string;
  description: string;
  pr: string | null;
}

interface HistoryResponse {
  ok: boolean;
  items: HistoryItem[];
}

const REALMS = ["ru", "eu", "na", "asia", "cn"];

/** Locale picker labels: language names always render in their own
 *  language (display constants, not translatable copy — the retired page
 *  shipped the very same table). */
const LOCALE_NAMES: Record<string, string> = {
  "en-US": "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  "ja-JP": "日本語",
  "ko-KR": "한국어",
  "ru-RU": "Русский",
  "fr-FR": "Français",
  "es-ES": "Español",
};

/** Bitable statuses (Chinese single-select) → i18n keys; the two terminal
 *  statuses get the "done" accent. Same table as the retired page. */
const STATUS_KEYS: Record<string, string> = {
  待审查: "statusPending",
  已确认: "statusConfirmed",
  已开PR: "statusPR",
  无需修复: "statusWontFix",
  需补充: "statusNeedInfo",
};
const STATUS_DONE: Record<string, boolean> = { 已开PR: true, 无需修复: true };

function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) — the UI keeps working */
  }
}

/** The anonymous submitter id, minted once per browser (same shape and
 *  key the embedded page used). */
function ensureAnonId(): string {
  let anon = lsGet("wowsp_fb_anon");
  if (!anon) {
    anon = (crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random()
    ).replace(/-/g, "");
    anon = anon.slice(0, 24);
    lsSet("wowsp_fb_anon", anon);
  }
  return anon;
}

/** The saved lookup credential: prefer the one stored under the saved
 *  contact, fall back to the most recent one (audit M-7 keys). */
function savedToken(): string {
  const contact = lsGet("wowsp_fb_contact").trim();
  const keyed = contact ? lsGet(`wowsp_fb_token:${contact}`) : "";
  return keyed || lsGet("wowsp_fb_token");
}

export default defineComponent({
  name: "FeedbackApp",
  setup() {
    const { t, te, locale } = useI18n();
    const toast = useToast();
    // The stacking threshold (md = 768px) — same boundary the layout
    // sheet's media query keys on; the sidebar's WIDTH must follow it
    // through the prop (inline style), not a class rule.
    const { isBelow } = useBreakpoint();
    const stacked = isBelow("md");

    // ── config + query prefill ─────────────────────────────────────────
    const cfg = ref<FeedbackConfig | null>(null);
    const cfgError = ref("");
    const query = new URLSearchParams(window.location.search);

    // The retired embedded page landed on the history view when the link
    // asked for it (?focus=history — the desktop app's 历史记录 button) or
    // carried a lookup token; the hikari port dropped that handoff — keep
    // the same trigger here.
    const view = ref<"form" | "history">(
      query.get("focus") === "history" || query.get("token") ? "history" : "form",
    );

    // ── form state ─────────────────────────────────────────────────────
    const description = ref("");
    const contact = ref(lsGet("wowsp_fb_contact"));
    const version = ref(query.get("version") ?? "");
    const sysinfo = ref(query.get("sysinfo") ?? "");
    const channel = ref(query.get("channel") ?? "web");
    const server = ref(REALMS.includes(query.get("server") ?? "") ? (query.get("server") as string) : lsGet("wowsp-fb-server"));
    const gameId = ref(query.get("game_id") ?? lsGet("wowsp-fb-gameid"));

    // Contact placeholder mirrors the kind being typed (QQ digits vs an
    // email) — parity with the retired page's category chip.
    const contactPlaceholder = computed(() =>
      contact.value.includes("@") ? t("contactPhEmail") : t("contactPhQQ"),
    );
    watch(contact, (v) => lsSet("wowsp_fb_contact", v));
    watch(server, (v) => (v ? lsSet("wowsp-fb-server", v) : localStorage.removeItem("wowsp-fb-server")));
    watch(gameId, (v) => (v ? lsSet("wowsp-fb-gameid", v) : localStorage.removeItem("wowsp-fb-gameid")));

    // ── attachment (single file, image/video preview) ──────────────────
    interface Attachment {
      blob: Blob;
      name: string;
      url: string;
      kind: "image" | "video" | "other";
    }
    const attachment = ref<Attachment | null>(null);
    const fileInput = ref<HTMLInputElement | null>(null);

    function setAttachment(blob: Blob | null, name: string | null) {
      if (attachment.value) URL.revokeObjectURL(attachment.value.url);
      if (!blob || !name) {
        attachment.value = null;
        return;
      }
      const kind = blob.type.startsWith("video/")
        ? "video"
        : blob.type.startsWith("image/")
          ? "image"
          : "other";
      attachment.value = { blob, name, url: URL.createObjectURL(blob), kind };
    }
    function onFileChange() {
      const file = fileInput.value?.files?.[0];
      if (file) setAttachment(file, file.name);
    }
    function clearAttachment() {
      if (fileInput.value) fileInput.value.value = "";
      setAttachment(null, null);
    }
    function sizeLabel(blob: Blob): string {
      return `(${(blob.size / 1048576).toFixed(1)} MB)`;
    }

    // ── captcha ────────────────────────────────────────────────────────
    const capAttempt = ref(0);
    const captchaToken = ref("");

    // ── submit ─────────────────────────────────────────────────────────
    const submitting = ref(false);
    const revealToken = ref("");
    const recordUrl = ref("");

    function errorText(e: unknown): string {
      const code = e instanceof Error ? e.message : String(e);
      if (code === "maintenance") return t("maintenance");
      const key = `e_${code}`;
      return te(key) ? t(key) : t("e_upstream");
    }

    async function submit() {
      if (!description.value.trim()) {
        toast.error(t("e_empty_description"));
        return;
      }
      if (cfg.value?.sitekey && !captchaToken.value) {
        toast.error(t("e_turnstile"));
        return;
      }
      submitting.value = true;
      try {
        // Field caps mirror the old page's maxlength attributes (the
        // worker's clean() clamps again server-side).
        const res = await submitFeedback(
          {
            description: description.value,
            contact: contact.value.slice(0, 64),
            version: version.value,
            sysinfo: sysinfo.value.slice(0, 200),
            channel: channel.value,
            anon: ensureAnonId(),
            server: server.value,
            game_id: gameId.value.slice(0, 32),
            file: attachment.value?.blob ?? null,
            fileName: attachment.value?.name,
          },
          captchaToken.value,
        );
        toast.success(t("ok"));
        if (res.lookup_token) {
          // One-time credential: persist under the audit-M-7 keys (last
          // token + keyed by the submitted contact) and reveal once.
          revealToken.value = res.lookup_token;
          lsSet("wowsp_fb_token", res.lookup_token);
          const cval = contact.value.trim();
          if (cval) lsSet(`wowsp_fb_token:${cval}`, res.lookup_token);
        }
        recordUrl.value = res.record_url ?? "";
        description.value = "";
        clearAttachment();
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        // The Turnstile token is single-use whatever the outcome — force
        // the widget to mint a fresh one.
        captchaToken.value = "";
        capAttempt.value += 1;
        submitting.value = false;
      }
    }

    // ── history ────────────────────────────────────────────────────────
    // An explicit ?token= handoff outranks the browser's saved credential
    // (the embedded page's exact precedence).
    const histToken = ref(query.get("token") || savedToken());
    const histLoading = ref(false);
    const histItems = ref<HistoryItem[] | null>(null);

    function statusLabel(status: string): string {
      const key = STATUS_KEYS[status];
      return key ? t(key) : status;
    }

    async function loadHistory() {
      const tok = histToken.value.trim();
      if (!tok) return;
      histLoading.value = true;
      try {
        const res = (await getFeedbackHistory(tok)) as HistoryResponse;
        if (!res.ok) throw new Error("bad response");
        histItems.value = res.items;
      } catch {
        histItems.value = null;
        toast.error(t("historyFailed"));
      } finally {
        histLoading.value = false;
      }
    }

    // ── language switcher (persists to the console's locale key) ───────
    function localeOptions() {
      return FEEDBACK_LOCALES.map((code) => ({
        value: code,
        label: LOCALE_NAMES[code] ?? code,
      }));
    }
    const currentLocale = computed({
      get: () => locale.value as string,
      set: (v: string) => {
        locale.value = v;
        lsSet("wowsp-fb-locale", v);
        document.documentElement.lang = v;
      },
    });

    // Entering the history view with an empty input refills the saved
    // credential (parity with the embedded page's auto-fill).
    watch(view, (v) => {
      if (v === "history" && !histToken.value.trim()) histToken.value = savedToken();
    });

    // Bound slot objects — HkNavItem normalizes bound identifiers into
    // slots (an inline literal stringifies; the same gotcha the admin
    // table page documents).
    const navFormSlots = {
      icon: () => <MessageSquareText size={16} />,
      default: () => t("navFeedback"),
    };
    const navHistorySlots = {
      icon: () => <History size={16} />,
      default: () => t("navHistory"),
    };

    onMounted(async () => {
      // Landing on the history view with a credential in hand (query
      // token or the browser's saved one) loads the list straight away —
      // the embedded page auto-loaded its focus=history handoff too.
      if (view.value === "history" && histToken.value.trim()) void loadHistory();
      try {
        const conf = await getFeedbackConfig();
        cfg.value = conf;
        if (!version.value && conf.latestVersion) version.value = conf.latestVersion;
        document.title = `WoWSP 反馈台 · v${conf.latestVersion}`;
      } catch (e) {
        cfgError.value = e instanceof Error ? e.message : String(e);
        toast.error(t("e_upstream"));
      }
    });

    const captchaDisabled = computed(() => !!cfg.value && !cfg.value.sitekey);

    function renderForm() {
      return (
        <div class="fb-form">
          <p class="fb-sub">{t("subtitle")}</p>
          {captchaDisabled.value ? <p class="fb-notice">{t("maintenance")}</p> : null}
          <div>
            <span class="fb-cap">{t("descLabel")}</span>
            <HkTextarea
              v-model={description.value}
              maxLength={5000}
              showCount
              rows={5}
            />
          </div>
          <HkInput
            v-model={contact.value}
            label={t("contactLabel")}
            placeholder={contactPlaceholder.value}
          />
          <HkInput
            v-model={sysinfo.value}
            label={t("sysLabel")}
          />
          <HkSelect
            v-model={version.value}
            label={t("versionLabel")}
            placeholder={t("versionLabel")}
            options={
              cfg.value?.latestVersion
                ? [{ value: cfg.value.latestVersion, label: cfg.value.latestVersion }]
                : []
            }
          />
          <HkSelect
            v-model={server.value}
            label={t("serverGameLabel")}
            placeholder={t("serverNone")}
            options={[
              { value: "", label: t("serverNone") },
              ...REALMS.map((r) => ({ value: r, label: t(`server${r.toUpperCase()}`) })),
            ]}
          />
          <HkInput
            v-model={gameId.value}
            label={t("gameIdPh")}
          />
          <div>
            <span class="fb-cap">{t("fileLabel")}</span>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".zip,.log,.txt,.gz,.png,.jpg,.jpeg,.gif,.webp,.bmp,.webm,.mp4,.mov"
              onChange={onFileChange}
            />
            <HkButton
              variant="secondary"
              size="sm"
              onClick={() => fileInput.value?.click()}
            >
              <Paperclip size={14} />
              {t("filePick")}
            </HkButton>
            {attachment.value ? (
              <div class="fb-attach">
                <div class="fb-attach-media">
                  {attachment.value.kind === "image" ? (
                    <HkImagePreview
                      src={attachment.value.url}
                      alt={attachment.value.name}
                      ratio="1 / 1"
                    />
                  ) : attachment.value.kind === "video" ? (
                    <video src={attachment.value.url} controls muted playsinline preload="metadata" />
                  ) : (
                    <span class="fb-attach-ext">
                      {(attachment.value.name.split(".").pop() ?? "?").slice(0, 6).toUpperCase()}
                    </span>
                  )}
                </div>
                <div class="fb-attach-meta">
                  <span>
                    {attachment.value.name} {sizeLabel(attachment.value.blob)}
                  </span>
                  <HkButton variant="ghost" size="sm" onClick={clearAttachment}>
                    <X size={14} />
                    {t("attachClear")}
                  </HkButton>
                </div>
              </div>
            ) : null}
          </div>
          {/* Mount only once the config is in: HkCaptchaWidget renders
              its challenge ONCE at mount, and the sitekey arrives from
              the async getFeedbackConfig — a widget mounted against the
              empty default stays a 0-height host forever (the challenge
              never appeared until this guard). An empty configured
              sitekey still mounts, into the widget's placeholder mode. */}
          {cfg.value ? (
            <HkCaptchaWidget
              siteKey={cfg.value.sitekey}
              attempt={capAttempt.value}
              onVerify={(token: string) => (captchaToken.value = token)}
            />
          ) : null}
          <HkButton
            block
            loading={submitting.value}
            disabled={submitting.value || captchaDisabled.value || cfgError.value !== ""}
            onClick={submit}
          >
            {t("submit")}
          </HkButton>
          {revealToken.value ? (
            <div class="fb-reveal">
              <p class="fb-reveal-title">{t("tokenTitle")}</p>
              <HkCopyBadge value={revealToken.value} mono>
                {revealToken.value}
              </HkCopyBadge>
              <p class="fb-reveal-help">{t("tokenHelp")}</p>
            </div>
          ) : null}
          {recordUrl.value ? (
            <p class="fb-ok-line">
              {t("ok")}
              <a href={recordUrl.value} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                {t("viewRecord")}
              </a>
            </p>
          ) : null}
          <p class="fb-privacy">{t("privacy")}</p>
        </div>
      );
    }

    function renderHistory() {
      return (
        <div class="fb-form">
          <h2 class="fb-view-title">{t("historyTitle")}</h2>
          <div class="fb-hist-row">
            <HkInput
              v-model={histToken.value}
              placeholder={t("historyToken")}
              spellcheck={false}
              submitOnEnter={loadHistory}
            />
            <HkButton loading={histLoading.value} onClick={loadHistory}>
              <History size={14} />
              {t("historyGo")}
            </HkButton>
          </div>
          {histItems.value === null ? null : histItems.value.length === 0 ? (
            <p class="fb-empty">{t("historyEmpty")}</p>
          ) : (
            <div>
              <p class="fb-hist-count">
                {t("historyCount").replace("#n", String(histItems.value.length))}
              </p>
              {histItems.value.map((it, i) => {
                const date = it.time ? new Date(it.time).toLocaleString(locale.value) : "";
                return (
                  <div class="fb-item" key={i}>
                    <div class="fb-item-meta">
                      <span class={["fb-status", STATUS_DONE[it.status] ? "is-done" : ""]}>
                        {statusLabel(it.status)}
                      </span>
                      <span>{date}</span>
                      {it.pr ? (
                        <a href={it.pr} target="_blank" rel="noreferrer">
                          PR
                        </a>
                      ) : null}
                    </div>
                    <p class="fb-desc">{it.description}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    return () => (
      // The original two-pane shell, rebuilt on hikari components: one
      // glass card centered on the page, HSidebar (brand / view nav /
      // language) docked left, the active view scrolling on the right
      // (HkScrollContainer). Below the md breakpoint the panes stack —
      // the sidebar stretches to full width via its WIDTH PROP (the
      // component writes it as an inline style, which no class rule can
      // override), driven by hikari's own useBreakpoint.
      <main class="fb-page">
        <HkToast />
        <HkCard class="fb-card" padded={false}>
          <HSidebar class="fb-side" width={stacked.value ? "100%" : "13rem"}>
            {{
              // Brand rides the body slot like the retired page (its
              // header band's min-height + divider read as an app
              // toolbar, not a form sidebar). The logo rides beside the
              // title at the nav items' icon rhythm; a failed load
              // (offline dev) just drops the glyph.
              default: () => (
                <div class="fb-side-flow">
                  <div class="fb-brand-row">
                    <img
                      class="fb-logo"
                      src="/logo.webp"
                      alt=""
                      onError={(e: Event) => {
                        (e.target as HTMLElement).style.display = "none";
                      }}
                    />
                    <h1 class="fb-brand">WoWSP 反馈台</h1>
                  </div>
                  <nav class="fb-side-nav">
                    <HkNavItem active={view.value === "form"} onClick={() => (view.value = "form")}>
                      {navFormSlots}
                    </HkNavItem>
                    <HkNavItem active={view.value === "history"} onClick={() => (view.value = "history")}>
                      {navHistorySlots}
                    </HkNavItem>
                  </nav>
                </div>
              ),
              footer: () => (
                <HkSelect
                  v-model={currentLocale.value}
                  label={t("langLabel")}
                  options={localeOptions()}
                />
              ),
            }}
          </HSidebar>
          <HkScrollContainer axis="vertical" class="fb-content">
            <div class="fb-content-pad">
              {cfgError.value ? (
                // Config-fetch failure — the app-wide error card standard
                // (2026-10 direction): raw failure text lives structured in
                // the JSON pane, never as a bare banner sentence.
                <HkErrorLanding variant="inline" tone="warning" title={t("maintenance")} copyText={cfgError.value}>
                  {{
                    default: () => <HkJsonTree value={{ message: cfgError.value }} ariaLabel="raw error details" />,
                  }}
                </HkErrorLanding>
              ) : null}
              {!cfg.value && !cfgError.value ? <HkSpinner size="md" /> : null}
              {view.value === "form" ? renderForm() : renderHistory()}
            </div>
          </HkScrollContainer>
        </HkCard>
      </main>
    );
  },
});
