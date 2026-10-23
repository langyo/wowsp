/**
 * The 人员管理 tab (admin tier only): the Feishu org's user list with a
 * grant/revoke toggle per row for the console's MEMBER tier (KV
 * `erp:members` — view access). Admin-tier rows (env-configured) are
 * labelled and locked; the listing needs the Feishu contact scopes and
 * answers a `contact:…` error code until they are granted — surfaced
 * here with the grant guidance instead of a bare failure.
 */

import { defineComponent, onMounted, ref } from "vue";
import {
  HkAdminTablePage,
  HButton,
  HkConfirmDialog,
  HAvatar,
  useToast,
} from "@celestia-island/hikari";

import { getErpMembers, getErpUsers, setErpMember, type ErpOrgUser } from "@/shared/api";

import { useConfirm } from "./confirm";

const PAGE_SIZE = 50;

export default defineComponent({
  name: "PeopleView",
  props: {
    /** Called when a list/write fails with a dead session — ErpApp flips
     *  back to the login card. */
    onSessionLost: { type: Function, required: true },
  },
  setup(props) {
    const toast = useToast();

    const users = ref<ErpOrgUser[]>([]);
    const members = ref<string[]>([]);
    const admins = ref<string[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const nextToken = ref<string | null>(null);
    const pageToken = ref<string | null>(null);
    const prevStack = ref<(string | null)[]>([]);
    const savingId = ref<string | null>(null);

    const { state: confirmState, confirm, onConfirm, onCancel } = useConfirm();

    function isAuthErr(e: unknown): boolean {
      const msg = e instanceof Error ? e.message : String(e);
      return msg === "unauthorized" || msg === "forbidden" || msg === "HTTP 401" || msg === "HTTP 403";
    }

    async function loadMembers(): Promise<void> {
      try {
        const res = await getErpMembers();
        members.value = res.members ?? [];
        admins.value = res.admins ?? [];
      } catch (e) {
        if (isAuthErr(e)) {
          props.onSessionLost();
          return;
        }
        // Non-fatal: the grant column falls back to unknown (no marks).
        members.value = [];
        admins.value = [];
      }
    }

    async function load(token: string | null): Promise<void> {
      loading.value = true;
      error.value = null;
      try {
        const page = await getErpUsers(token ?? undefined);
        users.value = page.users ?? [];
        nextToken.value = page.next_page_token ?? null;
        pageToken.value = token;
        await loadMembers();
      } catch (e) {
        if (isAuthErr(e)) {
          props.onSessionLost();
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        error.value = msg.startsWith("contact:")
          ? `飞书通讯录读取失败（${msg.slice("contact:".length)}）：请在飞书开放平台为应用开通通讯录权限（contact:user.base:readonly 与 contact:department.base:readonly），并将通讯录数据权限设为「全部成员」后重试。`
          : `加载失败：${msg}`;
      } finally {
        loading.value = false;
      }
    }

    onMounted(() => {
      void load(null);
    });

    function goNext(): void {
      if (!nextToken.value) return;
      prevStack.value.push(pageToken.value);
      void load(nextToken.value);
    }

    function goPrev(): void {
      void load(prevStack.value.pop() ?? null);
    }

    const pendingUser = ref<ErpOrgUser | null>(null);

    function askToggle(user: ErpOrgUser): void {
      const granted = members.value.includes(user.open_id);
      pendingUser.value = user;
      confirm(
        {
          title: granted ? "撤销后台权限" : "授予后台权限",
          message: granted
            ? `将撤销 ${user.name || user.open_id} 查看该后台的权限（其现有会话在下一次请求时立即失效）。`
            : `将授予 ${user.name || user.open_id} 查看该后台的权限（可查看反馈记录与录像征集，不含人员管理）。`,
          confirmLabel: granted ? "撤销" : "授予",
          danger: granted,
        },
        async () => {
          const target = pendingUser.value;
          if (!target) return;
          savingId.value = target.open_id;
          try {
            const res = await setErpMember(
              target.open_id,
              granted ? "remove" : "add",
            );
            members.value = res.members ?? [];
            toast.success(granted ? "已撤销权限" : "已授予权限");
          } catch (e) {
            if (isAuthErr(e)) {
              props.onSessionLost();
              return;
            }
            toast.error(`操作失败：${e instanceof Error ? e.message : String(e)}`);
          } finally {
            savingId.value = null;
          }
        },
      );
    }

    // Bound identifier — slot objects normalize from bound identifiers
    // (the HkAdminTablePage gotcha).
    const tableSlots = {
      "cell-name": ({ row }: { row: ErpOrgUser }) => (
        <div class="erp-people-name">
          <HAvatar name={row.name || row.open_id} src={row.avatar || ""} size="sm" />
          <span>{row.name || "（未授权通讯录）"}</span>
        </div>
      ),
      "cell-openid": ({ row }: { row: ErpOrgUser }) => (
        <span class="erp-people-mono">{row.open_id}</span>
      ),
      "cell-role": ({ row }: { row: ErpOrgUser }) => {
        if (admins.value.includes(row.open_id)) return <span class="erp-people-admin">管理员</span>;
        if (members.value.includes(row.open_id)) return <span class="erp-people-member">可查看</span>;
        return <span class="erp-muted">—</span>;
      },
      "cell-actions": ({ row }: { row: ErpOrgUser }) => {
        if (admins.value.includes(row.open_id)) {
          return <span class="erp-muted">环境配置，不可在此修改</span>;
        }
        const granted = members.value.includes(row.open_id);
        return (
          <HButton
            size="sm"
            variant={granted ? "secondary" : "primary"}
            loading={savingId.value === row.open_id}
            onClick={() => askToggle(row)}
          >
            {granted ? "撤销权限" : "授予查看权限"}
          </HButton>
        );
      },
    };

    return () => (
      <div class="erp-view">
        <HkAdminTablePage
          dense
          loading={loading.value}
          error={error.value ?? undefined}
          rows={users.value as unknown as Record<string, unknown>[]}
          rowKey="open_id"
          emptyTitle="没有成员"
          emptyDescription="飞书组织下没有可见成员——请检查应用的通讯录数据权限是否设为「全部成员」。"
          columns={[
            { key: "name", title: "成员" },
            { key: "openid", title: "Open ID", width: "260px" },
            { key: "role", title: "后台权限", width: "120px" },
            { key: "actions", title: "操作", width: "160px" },
          ]}
        >
          {tableSlots}
        </HkAdminTablePage>
        <div class="erp-pager">
          <HButton size="sm" variant="secondary" disabled={!prevStack.value.length} onClick={goPrev}>
            上一页
          </HButton>
          <HButton size="sm" variant="secondary" disabled={!nextToken.value} onClick={goNext}>
            下一页
          </HButton>
          <span class="erp-muted">
            {users.value.length} 条（每页至多 {PAGE_SIZE}）
          </span>
          <HButton
            size="sm"
            variant="ghost"
            loading={loading.value}
            onClick={() => void load(pageToken.value)}
          >
            刷新
          </HButton>
        </div>
        <HkConfirmDialog
          open={confirmState.open}
          onUpdate:open={(v: boolean) => (confirmState.open = v)}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          confirmVariant={confirmState.danger ? "danger" : "primary"}
          loading={confirmState.loading || savingId.value !== null}
          onConfirm={() => void onConfirm()}
          onCancel={onCancel}
        />
      </div>
    );
  },
});
