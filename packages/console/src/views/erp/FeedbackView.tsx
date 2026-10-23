/**
 * The review tab: the feedback records table (GET /api/feedback/list,
 * worker `handle_list` shape) with per-row status transition + PR-link
 * editing (POST /api/feedback/update, `handle_update` shape), the status
 * filter chips (STATUSES = relay-core feedback::STATUSES), and the
 * page_token pager. Every write is confirmed through HkConfirmDialog;
 * failures ride the toast; 401/403 hands the surface back to login.
 */

import { computed, defineComponent, onMounted, reactive, ref } from "vue";
import {
  HkAdminTablePage,
  HButton,
  HkConfirmDialog,
  HInput,
  HkSelect,
  HTabs,
  useToast,
} from "@celestia-island/hikari";

import {
  isAuthError,
  listFeedbackPage,
  updateFeedbackRow,
  type FeedbackItem,
  type FeedbackListPage,
} from "./api";
import { fmtTime } from "./format";

/** The review statuses — verbatim relay-core feedback::STATUSES (the
 *  server rejects anything else with 400 bad_status). */
const STATUSES = ["待审查", "已确认", "已开PR", "无需修复", "需补充"] as const;

const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: s }));

/** Per-row edit drafts (the select + input the row's 保存 posts). */
interface RowDraft {
  status: string;
  pr: string;
}

export default defineComponent({
  name: "FeedbackView",
  props: {
    /** Called when a list/write fails with a dead session — ErpApp flips
     *  back to the login card. */
    onSessionLost: { type: Function, required: true },
  },
  setup(props) {
    const toast = useToast();

    const items = ref<FeedbackItem[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const filter = ref<string>("");

    // page_token pagination (NOT page numbers — see listFeedbackPage).
    const pageToken = ref<string | null>(null);
    const nextToken = ref<string | null>(null);
    const prevStack = ref<(string | null)[]>([]);

    const drafts = reactive(new Map<string, RowDraft>());
    const savingId = ref<string | null>(null);

    function seedDrafts(rows: FeedbackItem[]): void {
      for (const it of rows) {
        if (!drafts.has(it.record_id)) {
          drafts.set(it.record_id, { status: it.status, pr: it.pr ?? "" });
        }
      }
    }

    async function load(token: string | null): Promise<void> {
      loading.value = true;
      error.value = null;
      try {
        const page: FeedbackListPage = await listFeedbackPage(token);
        items.value = page.items ?? [];
        nextToken.value = page.next_page_token ?? null;
        pageToken.value = token;
        seedDrafts(items.value);
      } catch (e) {
        if (isAuthError(e)) {
          props.onSessionLost();
          return;
        }
        error.value = `加载失败：${e instanceof Error ? e.message : String(e)}`;
      } finally {
        loading.value = false;
      }
    }

    onMounted(() => {
      void load(null);
    });

    const filtered = computed(() =>
      filter.value ? items.value.filter((it) => it.status === filter.value) : items.value,
    );

    const filterTabs = computed(() => [
      { key: "", label: "全部" },
      ...STATUSES.map((s) => ({ key: s, label: s })),
    ]);

    // Rows may carry a status the current STATUSES list no longer names
    // (renamed server-side) — keep it selectable so the row stays honest.
    function statusOptions(row: FeedbackItem) {
      const extra = row.status && !STATUSES.includes(row.status as (typeof STATUSES)[number]);
      return extra ? [{ value: row.status, label: row.status }, ...STATUS_OPTIONS] : STATUS_OPTIONS;
    }

    function draftOf(row: FeedbackItem): RowDraft {
      return (
        drafts.get(row.record_id) ?? { status: row.status, pr: row.pr ?? "" }
      );
    }

    function setDraft(row: FeedbackItem, patch: Partial<RowDraft>): void {
      drafts.set(row.record_id, { ...draftOf(row), ...patch });
    }

    const confirmState = reactive({
      open: false,
      row: null as FeedbackItem | null,
    });

    function askSave(row: FeedbackItem): void {
      const draft = draftOf(row);
      if (draft.pr.trim() && !draft.pr.trim().startsWith("https://")) {
        toast.error("PR 链接必须以 https:// 开头。");
        return;
      }
      if (!draft.status) {
        toast.error("请先选择一个状态。");
        return;
      }
      confirmState.row = row;
      confirmState.open = true;
    }

    async function doSave(): Promise<void> {
      const row = confirmState.row;
      if (!row) return;
      const draft = draftOf(row);
      savingId.value = row.record_id;
      try {
        await updateFeedbackRow({
          record_id: row.record_id,
          status: draft.status,
          pr_link: draft.pr.trim(),
        });
        toast.success(`已保存 ${row.record_id}`);
        await load(pageToken.value);
      } catch (e) {
        if (isAuthError(e)) {
          props.onSessionLost();
          return;
        }
        toast.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        savingId.value = null;
      }
    }

    function goNext(): void {
      if (!nextToken.value) return;
      prevStack.value.push(pageToken.value);
      void load(nextToken.value);
    }

    function goPrev(): void {
      void load(prevStack.value.pop() ?? null);
    }

    // Bound identifier for the slot object — an inline literal is not
    // normalized to slots (see HkAdminTablePage's own note).
    const tableSlots = {
      "cell-time": ({ row }: { row: FeedbackItem }) => <span>{fmtTime(row.time)}</span>,
      "cell-description": ({ row }: { row: FeedbackItem }) => (
        <div>
          <div>{row.description || "—"}</div>
          {row.sysinfo ? <div class="erp-muted">{row.sysinfo}</div> : null}
          {row.server || row.game_id ? (
            <div class="erp-muted">
              {row.server ? `🌐 ${row.server.toUpperCase()}` : ""}
              {row.server && row.game_id ? " · " : ""}
              {row.game_id ? `🆔 ${row.game_id}` : ""}
            </div>
          ) : null}
          {row.record_url ? (
            <div class="erp-row-actions">
              <a href={row.record_url} target="_blank" rel="noreferrer">
                记录
              </a>
            </div>
          ) : null}
        </div>
      ),
      "cell-status": ({ row }: { row: FeedbackItem }) => (
        <HkSelect
          modelValue={draftOf(row).status}
          onUpdate:modelValue={(v: string) => setDraft(row, { status: v })}
          options={statusOptions(row)}
        />
      ),
      "cell-pr": ({ row }: { row: FeedbackItem }) => (
        <div>
          <HInput
            modelValue={draftOf(row).pr}
            onUpdate:modelValue={(v: string) => setDraft(row, { pr: v })}
            placeholder="PR URL"
          />
          <div class="erp-row-actions">
            <HButton
              size="sm"
              variant="secondary"
              loading={savingId.value === row.record_id}
              onClick={() => askSave(row)}
            >
              保存
            </HButton>
          </div>
        </div>
      ),
      "cell-attachments": ({ row }: { row: FeedbackItem }) => (
        <div>
          {(row.attachments ?? []).length ? (
            row.attachments.map((a) => (
              <div key={a.url}>
                <a href={a.url} target="_blank" rel="noreferrer">
                  {a.name}
                </a>
              </div>
            ))
          ) : (
            <span class="erp-muted">—</span>
          )}
        </div>
      ),
      filter: () => (
        <HTabs
          variant="segmented"
          modelValue={filter.value}
          onUpdate:modelValue={(v: string) => (filter.value = v)}
          tabs={filterTabs.value}
        />
      ),
    };

    return () => (
      <div class="erp-view">
        {/* The stretch wrapper: consumes the leftover viewport height so
            the table card / empty state fills short pages (see the
            .erp-table rules in ErpApp's page styles). */}
        <div class="erp-table">
          <HkAdminTablePage
            dense
            loading={loading.value}
            error={error.value ?? undefined}
            rows={filtered.value as unknown as Record<string, unknown>[]}
            rowKey="record_id"
            emptyTitle="暂无反馈记录"
            emptyDescription={filter.value ? "当前筛选下没有记录——切换到「全部」看看。" : undefined}
            columns={[
              { key: "time", title: "提交时间", width: "150px" },
              { key: "description", title: "描述" },
              { key: "contact", title: "联系", width: "120px" },
              { key: "version", title: "版本", width: "90px" },
              { key: "channel", title: "渠道", width: "80px" },
              { key: "status", title: "状态", width: "150px" },
              { key: "pr", title: "PR", width: "210px" },
              { key: "attachments", title: "附件", width: "130px" },
            ]}
          >
            {tableSlots}
          </HkAdminTablePage>
        </div>
        <div class="erp-pager">
          <HButton size="sm" variant="secondary" disabled={!prevStack.value.length} onClick={goPrev}>
            上一页
          </HButton>
          <HButton size="sm" variant="secondary" disabled={!nextToken.value} onClick={goNext}>
            下一页
          </HButton>
          <span class="erp-muted">
            {filtered.value.length} 条{nextToken.value ? " · 有下一页" : ""}
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
          title="保存修改"
          message={
            confirmState.row
              ? `将把 ${confirmState.row.record_id} 的状态更新为「${draftOf(confirmState.row).status}」并保存 PR 链接（留空 PR 表示不修改链接）。`
              : ""
          }
          confirmLabel="保存"
          confirmVariant="primary"
          onConfirm={() => void doSave()}
          onCancel={() => (confirmState.open = false)}
        />
      </div>
    );
  },
});
