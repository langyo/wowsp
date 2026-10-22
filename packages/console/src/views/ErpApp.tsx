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

import { computed, defineComponent, onMounted, ref } from "vue";
import {
  HkAdminHeader,
  HkAdminShell,
  HAlert,
  HkAuthCard,
  HAvatar,
  HButton,
  HkConfirmDialog,
  HkCopyBadge,
  HNavItem,
  HkLoadingVeil,
  HModal,
  HToast,
  HTabs,
  setLocale,
  useToast,
} from "@celestia-island/hikari";
import { MessageSquareText, Package } from "@lucide/vue";

import { erpLogin, erpLogout, getErpSession, type ErpSession } from "@/shared/api";

import FeedbackView from "./erp/FeedbackView";
import ReplayAdminView from "./erp/ReplayAdminView";
import { useConfirm } from "./erp/confirm";

type ViewKey = "feedback" | "replays";

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: "feedback", label: "反馈记录" },
  { key: "replays", label: "录像征集" },
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

/** Page-level layout styles only (component chrome is hikari's). */
const ERP_STYLES = `
.erp-view { display: flex; flex-direction: column; gap: var(--space-16, 1rem); }
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
`;

export default defineComponent({
  name: "ErpApp",
  setup() {
    const toast = useToast();

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
          // A contact re-read that ended in anything but "refreshed" is
          // the worker telling us the profile is degraded — surface it
          // once, like the retired page did.
          if (s.debug && s.debug !== "refreshed") {
            toast.error(`通讯录读取：${s.debug}`);
          }
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

    const viewTitle = computed(
      () => VIEWS.find((v) => v.key === view.value)?.label ?? "",
    );

    // Bound slot objects — an inline literal is not normalized to slots
    // (the same gotcha HkAdminTablePage documents).
    const feedbackSlots = { onSessionLost: loseSession };
    const replaysSlots = { onSessionLost: loseSession };

    const navFeedbackSlots = {
      icon: () => <MessageSquareText size={16} />,
      default: () => "反馈记录",
    };
    const navReplaysSlots = {
      icon: () => <Package size={16} />,
      default: () => "录像征集",
    };

    const shellSlots = {
      header: (p: {
        showHamburger: boolean;
        compact: boolean;
        onHamburger: () => void;
        onOpenDrawer: () => void;
      }) => (
        <HkAdminHeader
          title={viewTitle.value}
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
                      <HAvatar name={session.value?.name || "飞书用户"} src={session.value?.avatar || ""} />
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
          </nav>
          <div class="erp-side-foot">
            <div class="erp-who">
              <HAvatar name={session.value?.name || "飞书用户"} src={session.value?.avatar || ""} size="sm" />
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
          {session.value?.open_access ? (
            <div class="erp-notice">
              <HAlert
                variant="warning"
                banner
                message="未配置后台允许名单：当前策略下，能登录该飞书应用的成员都可进入（如需收紧，把维护者 open_id 写入 ERP_ALLOWED_OPEN_IDS，或关闭 ERP_OPEN_ACCESS）。"
              />
              <div class="erp-notice-copy">
                <span class="erp-muted">你的 open_id（点按复制）：</span>
                <HkCopyBadge mono size="sm" variant="warning">
                  {session.value?.open_access}
                </HkCopyBadge>
              </div>
            </div>
          ) : null}
          <HTabs
            modelValue={view.value}
            onUpdate:modelValue={(v: string) => (view.value = v as ViewKey)}
            tabs={VIEWS.map((v) => ({ key: v.key, label: v.label }))}
          />
          {view.value === "feedback" ? <FeedbackView {...feedbackSlots} /> : <ReplayAdminView {...replaysSlots} />}
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
      <div>
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
