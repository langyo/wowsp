/**
 * The 贡献名单 tab: the published roster's lifetime credits
 * (GET /api/replays/admin/credits → `credits_response`) — one row per
 * (服务器, 署名) identity, already merged and sorted server-side (realm,
 * then name), and the source of contributors.json's 累计采纳 column. Any
 * console session may read it (member tier); 401/403 hands the surface
 * back to login.
 */

import { defineComponent, onMounted, ref } from "vue";
import { HkAdminTablePage, HButton } from "@celestia-island/hikari";

import { asIndexable } from "@/shared/typing";

import { getReplayAdminCredits, isAuthError, type CreditsResponse } from "./api";

type CreditRow = CreditsResponse["contributors"][number];

export default defineComponent({
  name: "CreditsView",
  props: {
    /** Called when the list fails with a dead session — ErpApp flips
     *  back to the login card. */
    onSessionLost: { type: Function, required: true },
  },
  setup(props) {
    const rows = ref<CreditRow[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);

    async function load(): Promise<void> {
      loading.value = true;
      error.value = null;
      try {
        const res = (await getReplayAdminCredits()) as CreditsResponse;
        rows.value = res.contributors ?? [];
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
      void load();
    });

    // Bound identifier — slot objects normalize from bound identifiers
    // (the HkAdminTablePage gotcha).
    const tableSlots = {
      "cell-name": ({ row }: { row: CreditRow }) => <span>{row.name}</span>,
      "cell-realm": ({ row }: { row: CreditRow }) => (
        <span>{(row.realm || "").toUpperCase()}</span>
      ),
      "cell-count": ({ row }: { row: CreditRow }) => <span>{row.count}</span>,
    };

    return () => (
      <div class="erp-view">
        <div class="erp-head-row">
          <span class="erp-muted">
            发布名单的累计口径——按（服务器, 署名）合并的历史采纳数（contributors.json 的来源）。
            {rows.value.length ? ` · 共 ${rows.value.length} 位贡献者` : ""}
          </span>
          <span class="erp-head-actions">
            <HButton size="sm" variant="ghost" onClick={() => void load()}>
              刷新
            </HButton>
          </span>
        </div>
        {/* The same stretch wrapper the other table pages ride: consumes
            the leftover viewport height so the table card fills short
            pages (see .erp-table in ErpApp's page styles). */}
        <div class="erp-table">
          <HkAdminTablePage
            dense
            loading={loading.value}
            error={error.value ?? undefined}
            rows={rows.value.map((r) => asIndexable({ ...r, key: `${r.realm}|${r.name}` }))}
            rowKey="key"
            emptyTitle="暂无贡献名单"
            emptyDescription="还没有任何已采纳的署名——发布名单为空。"
            columns={[
              { key: "name", title: "署名", width: "220px" },
              { key: "realm", title: "服务器", width: "120px" },
              { key: "count", title: "累计采纳" },
            ]}
          >
            {tableSlots}
          </HkAdminTablePage>
        </div>
      </div>
    );
  },
});
