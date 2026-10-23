/**
 * /erp console — the Feishu-gated review console (the hikari rebuild of
 * the retired embedded page in relay-core/src/erp.rs).
 *
 * Flow: getErpSession() gates everything — ok:false lands on the login
 * card (Feishu OAuth redirect, with the ?login=failed&reason=… copy the
 * old page showed); ok:true opens the HkAdminShell with the whoami
 * identity (header dropdown / mobile drawer) and two tabs: the feedback
 * review table and the replay-collection admin. Under the
 * ERP_OPEN_ACCESS legacy gate a persistent banner carries the caller's
 * open_id (HkCopyBadge) next to the ERP_ALLOWED_OPEN_IDS / ERP_OPEN_ACCESS
 * note. Every mutation confirms through HkConfirmDialog; errors toast.
 */

import { defineComponent, onMounted, ref, watch, type PropType } from "vue";
import {
  HkAdminHeader,
  HkAdminShell,
  HAlert,
  HkAuthCard,
  HAvatar,
  HButton,
  HkConfirmDialog,
  HNavItem,
  HkLoadingVeil,
  HModal,
  HToast,
  HTabs,
  setLocale,
} from "@celestia-island/hikari";
import { MessageSquareText, Package, Users } from "@lucide/vue";

import { erpLogin, erpLogout, getErpSession, type ErpSession } from "@/shared/api";

import FeedbackView from "./erp/FeedbackView";
import ReplayAdminView from "./erp/ReplayAdminView";
import PeopleView from "./erp/PeopleView";
import { useConfirm } from "./erp/confirm";

type ViewKey = "feedback" | "replays" | "people";

const VIEWS: { key: ViewKey; label: string; adminOnly?: boolean }[] = [
  { key: "feedback", label: "反馈记录" },
  { key: "replays", label: "录像征集" },
  // The people-management surface rides the ADMIN tier only — the nav
  // row and the header switcher both hide it from members.
  { key: "people", label: "人员管理", adminOnly: true },
];

/** The ?login=failed&reason=… copy — same strings the retired page
 *  toasts (relay-core/src/erp.rs showLogin). */
function loginFailureText(reason: string): string {
  if (reason === "denied") return "该飞书账号不在后台允许名单内，请联系维护者。";
  if (reason === "unconfigured") {
    return (
      "后台允许名单未配置，控制台已默认关闭。" +
      "把维护者 open_id 写入 ERP_ALLOWED_OPEN_IDS（或显式设置 ERP_OPEN_ACCESS=1）后重试。"
    );
  }
  return `登录失败（${reason}），请重试。`;
}

/** Page-level layout styles only (component chrome is hikari's). The
 *  fill chain hands the shell's definite viewport height down to the
 *  view: the shell's padded scroll child stretches (min-height:100%),
 *  `.erp-view` grows with it, and the active table region (`.erp-table`)
 *  consumes the remainder so the HkAdminTablePage card / empty state
 *  fills the space short content leaves over instead of baring canvas. */
const ERP_STYLES = `
.erp-root { height: 100%; }
.erp-root .s-admin-shell-scroll > .hk-scroll-container-viewport > div { min-height: 100%; display: flex; flex-direction: column; }
.erp-view { flex: 1 1 auto; display: flex; flex-direction: column; gap: var(--space-16, 1rem); min-height: 0; }
.erp-table { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.erp-table > div { flex: 1 1 auto; display: flex; flex-direction: column; }
.erp-table > div > .hk-empty-state { flex: 1 1 auto; max-width: none; }
.erp-table > div > .hk-card { flex: 1 1 auto; }
.erp-muted { color: rgb(var(--color-muted)); font-size: var(--text-sm, 0.8125rem); }
.erp-row-actions { display: flex; gap: var(--space-6, 6px); flex-wrap: wrap; margin-top: var(--space-6, 6px); align-items: center; }
.erp-pager { display: flex; gap: var(--space-8, 8px); align-items: center; flex-wrap: wrap; }
.erp-head-row { display: flex; align-items: center; gap: var(--space-12, 12px); flex-wrap: wrap; }
.erp-head-actions { display: flex; gap: var(--space-8, 8px); flex-wrap: wrap; margin-inline-start: auto; }
.erp-section-title { font-size: var(--text-md, 0.9375rem); font-weight: 600; margin: 0 0 var(--space-8, 8px); }
.erp-modal-actions { display: flex; justify-content: flex-end; gap: var(--space-8, 8px); }
.erp-form-col { display: flex; flex-direction: column; gap: var(--space-12, 12px); }
.erp-notice { display: flex; flex-direction: column; gap: var(--space-4, 4px); }
.erp-notice-copy { display: flex; align-items: center; gap: var(--space-8, 8px); flex-wrap: wrap; font-size: var(--text-sm, 0.8125rem); }
.erp-login-wrap { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: var(--space-20, 20px); }
.erp-login-col { width: min(92vw, 26rem); display: flex; flex-direction: column; gap: var(--space-12, 12px); }
.erp-side { display: flex; flex-direction: column; height: 100%; padding: var(--space-16, 16px) var(--space-12, 12px); gap: var(--space-12, 12px); }
.erp-brand { font-size: var(--text-lg, 1.0625rem); font-weight: 700; margin: 0; padding: 0 var(--space-8, 8px); }
.erp-side-nav { display: flex; flex-direction: column; gap: var(--space-4, 4px); }
.erp-side-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--space-8, 8px); min-width: 0; }
.erp-who { display: flex; align-items: center; gap: var(--space-8, 8px); padding: var(--space-6, 6px) var(--space-8, 8px); border-radius: var(--radius-md, 8px); background: color-mix(in srgb, rgb(var(--color-primary)) 8%, transparent); min-width: 0; }
.erp-who span { font-size: var(--text-sm, 0.8125rem); font-weight: 600; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.erp-people-name { display: flex; align-items: center; gap: var(--space-8, 8px); min-width: 0; }
.erp-people-mono { font-family: var(--font-mono, monospace); font-size: var(--text-xs, 0.75rem); color: rgb(var(--color-muted)); word-break: break-all; }
.erp-people-admin { color: rgb(var(--color-primary)); font-weight: 600; font-size: var(--text-sm, 0.8125rem); }
.erp-people-member { color: rgb(var(--color-success)); font-weight: 600; font-size: var(--text-sm, 0.8125rem); }
`;

/**
 * HkAvatar renders <img> for any non-empty src with no error fallback
 * (HkAdminHeader rolls its own onError letter fallback) — a dead profile
 * URL (the anonymized session's placeholder avatar) then shows a
 * broken-image glyph in the sidebar. Probe each URL once with an Image
 * and drop dead ones back to the initials view.
 */
const SafeAvatar = defineComponent({
  name: "SafeAvatar",
  props: {
    src: { type: String, default: "" },
    name: { type: String, default: "" },
    size: { type: String as PropType<"sm" | "md" | "lg">, default: "md" },
  },
  setup(props) {
    const ok = ref(true);
    watch(
      () => props.src,
      (src) => {
        ok.value = true;
        if (src) {
          const probe = new Image();
          probe.onerror = () => (ok.value = false);
          probe.src = src;
        }
      },
      { immediate: true },
    );
    return () => <HAvatar name={props.name} src={ok.value ? props.src : ""} size={props.size} />;
  },
});

export default defineComponent({
  name: "ErpApp",
  setup() {
    const phase = ref<"loading" | "login" | "ready">("loading");
    const session = ref<ErpSession | null>(null);
    const loginError = ref("");
    const view = ref<ViewKey>("feedback");
    const loggingOut = ref(false);

    const { state: confirmState, confirm, onConfirm, onCancel } = useConfirm();

    onMounted(async () => {
      // hikari's own chrome strings (drawer title, menus, tooltips) in
      // Chinese; the page text below is Chinese by construction.
      void setLocale("zh-Hans");
      try {
        const s = await getErpSession();
        if (s.ok) {
          session.value = s;
          phase.value = "ready";
          return;
        }
      } catch {
        /* network failure — same landing as an anonymous session */
      }
      const params = new URLSearchParams(window.location.search);
      loginError.value =
        params.get("login") === "failed" ? loginFailureText(params.get("reason") || "unknown") : "";
      phase.value = "login";
    });

    function loseSession(): void {
      session.value = null;
      loginError.value = "";
      phase.value = "login";
    }

    function askLogout(): void {
      confirm(
        {
          title: "退出登录",
          message: "将清除本机的后台会话 Cookie，需要重新通过飞书登录。",
          confirmLabel: "退出",
        },
        async () => {
          loggingOut.value = true;
          try {
            await erpLogout();
          } finally {
            loggingOut.value = false;
            loseSession();
          }
        },
      );
    }

    // A stale admin cookie (env list changed since mint) must not keep
    // a demoted holder on an admin-only view.
    watch(
      () => session.value?.admin,
      (admin) => {
        if (!admin && view.value === "people") view.value = "feedback";
      },
    );

    // Bound slot objects — an inline literal is not normalized to slots
    // (the same gotcha HkAdminTablePage documents).
    const feedbackSlots = { onSessionLost: loseSession };
    const replaysSlots = { onSessionLost: loseSession };
    const peopleSlots = { onSessionLost: loseSession };

    const navFeedbackSlots = {
      icon: () => <MessageSquareText size={16} />,
      default: () => "反馈记录",
    };
    const navReplaysSlots = {
      icon: () => <Package size={16} />,
      default: () => "录像征集",
    };
    const navPeopleSlots = {
      icon: () => <Users size={16} />,
      default: () => "人员管理",
    };

    const shellSlots = {
      header: (p: {
        showHamburger: boolean;
        compact: boolean;
        onHamburger: () => void;
        onOpenDrawer: () => void;
      }) => (
        <HkAdminHeader
          username={session.value?.name || "飞书用户"}
          avatarUrl={session.value?.avatar || ""}
          showHamburger={p.showHamburger}
          compact={p.compact}
          avatarAction={p.showHamburger ? "drawer" : "menu"}
          onHamburger={p.onHamburger}
          onAvatarClick={p.onOpenDrawer}
          logoutLabel="退出登录"
          onLogout={askLogout}
        >
          {{
            // The view switcher rides the header's page-owned centre
            // group — the balanced three-zone grid pins it to the true
            // viewport middle, the shittim-chest console grammar (the
            // in-content tab row it replaces floated mid-page instead
            // and duplicated the sidebar nav).
            center: () => (
              <HTabs
                modelValue={view.value}
                onUpdate:modelValue={(v: string) => (view.value = v as ViewKey)}
                tabs={VIEWS.filter((v) => !v.adminOnly || session.value?.admin).map((v) => ({
                  key: v.key,
                  label: v.label,
                }))}
              />
            ),
            "avatar-modal": (modal: { open: boolean; onUpdateOpen: (v: boolean) => void }) => (
              <HModal
                modelValue={modal.open}
                onUpdate:modelValue={modal.onUpdateOpen}
                title="当前账号"
                width="22rem"
              >
                {{
                  default: () => (
                    <div class="erp-form-col">
                      <SafeAvatar name={session.value?.name || "飞书用户"} src={session.value?.avatar || ""} />
                      <span>{session.value?.name || "飞书用户"}</span>
                      <span class="erp-muted">通过飞书 OAuth 登录的允许名单成员。</span>
                    </div>
                  ),
                }}
              </HModal>
            ),
          }}
        </HkAdminHeader>
      ),
      sidebar: (p: { onNavigate: () => void }) => (
        <div class="erp-side">
          <h1 class="erp-brand">WoWSP 反馈台</h1>
          <nav class="erp-side-nav">
            <HNavItem
              active={view.value === "feedback"}
              onClick={() => {
                view.value = "feedback";
                p.onNavigate();
              }}
            >
              {navFeedbackSlots}
            </HNavItem>
            <HNavItem
              active={view.value === "replays"}
              onClick={() => {
                view.value = "replays";
                p.onNavigate();
              }}
            >
              {navReplaysSlots}
            </HNavItem>
            {session.value?.admin ? (
              <HNavItem
                active={view.value === "people"}
                onClick={() => {
                  view.value = "people";
                  p.onNavigate();
                }}
              >
                {navPeopleSlots}
              </HNavItem>
            ) : null}
          </nav>
          <div class="erp-side-foot">
            <div class="erp-who">
              <SafeAvatar name={session.value?.name || "飞书用户"} src={session.value?.avatar || ""} size="sm" />
              <span>{session.value?.name || "飞书用户"}</span>
            </div>
          </div>
        </div>
      ),
      userPanel: (p: { onNavigate: () => void }) => (
        <div class="erp-form-col">
          <HButton
            variant="secondary"
            block
            onClick={() => {
              askLogout();
              p.onNavigate();
            }}
          >
            退出登录
          </HButton>
        </div>
      ),
      content: () => (
        <div class="erp-view">
          {view.value === "feedback" ? (
            <FeedbackView {...feedbackSlots} />
          ) : view.value === "replays" ? (
            <ReplayAdminView {...replaysSlots} />
          ) : session.value?.admin ? (
            <PeopleView {...peopleSlots} />
          ) : null}
        </div>
      ),
      overlays: () => (
        <>
          <HToast />
          <HkConfirmDialog
            open={confirmState.open}
            onUpdate:open={(v: boolean) => (confirmState.open = v)}
            title={confirmState.title}
            message={confirmState.message}
            confirmLabel={confirmState.confirmLabel}
            confirmVariant={confirmState.danger ? "danger" : "primary"}
            loading={confirmState.loading || loggingOut.value}
            onConfirm={() => void onConfirm()}
            onCancel={onCancel}
          />
        </>
      ),
    };

    const loginSlots = {
      footer: () => (
        <HButton variant="primary" block loading={loggingOut.value} onClick={() => erpLogin()}>
          使用飞书登录
        </HButton>
      ),
    };

    return () => (
      <div class="erp-root">
        <style>{ERP_STYLES}</style>
        <HkLoadingVeil active={phase.value === "loading"} label="正在检查登录状态…" />
        {phase.value === "login" ? (
          <div class="erp-login-wrap">
            <div class="erp-login-col">
              <HkAuthCard title="WoWSP 反馈台" subtitle="使用飞书账号登录后即可查看与处理反馈。">
                {{
                  default: () =>
                    loginError.value ? <HAlert variant="error" message={loginError.value} /> : null,
                  footer: loginSlots.footer,
                }}
              </HkAuthCard>
            </div>
          </div>
        ) : phase.value === "ready" ? (
          <HkAdminShell navTitle="导航">{shellSlots}</HkAdminShell>
        ) : null}
      </div>
    );
  },
});
