/**
 * The replay-collection admin tab: contributors + watermark
 * (GET /api/replays/admin/list → `handle_admin_list`), shard download
 * links (`/api/replays/admin/archive?anon_id=…`), the confirmed drain
 * (POST {anonIds}), the RAW wanted-ruleset editor (GET answers
 * `{exists, raw}`, POST takes the JSON text verbatim — `handle_admin_wanted`),
 * lifetime credits (`handle_admin_credits`), and the rename / backfill
 * forms (`handle_admin_rename` / `handle_admin_backfill` body shapes).
 * Every mutation arms the shared HkConfirmDialog first; 401/403 hands
 * the surface back to login.
 */

import { computed, defineComponent, onMounted, ref } from "vue";
import {
  HButton,
  HCard,
  HkConfirmDialog,
  HkCopyBadge,
  HkErrorLanding,
  HInput,
  HkJsonTree,
  HkSelect,
  HModal,
  HSkeletonList,
  HTable,
  HTextarea,
  useToast,
} from "@celestia-island/hikari";

import {
  getReplayAdminCredits,
  getReplayAdminList,
  getReplayAdminWanted,
  isAuthError,
  replayAdminArchiveUrl,
  replayAdminBackfill,
  replayAdminDrain,
  replayAdminRename,
  saveReplayAdminWanted,
  type AdminContributor,
  type BackfillMember,
  type BackfillOk,
  type CreditsResponse,
  type DrainResult,
  type ReplayAdminList,
  type WantedDoc,
  type WantedRaw,
  type WantedSaveOk,
} from "./api";
import { useConfirm } from "./confirm";
import { dimsOf, fmtBytes, fmtTime, WANTED_TEMPLATE } from "./format";

/** The realms `valid_realm` admits (relay-core replay::REALMS). */
const REALMS = ["ru", "eu", "na", "asia", "cn"] as const;
const REALM_OPTIONS = REALMS.map((r) => ({ value: r, label: r.toUpperCase() }));

const HEX64 = /^[0-9a-f]{64}$/;

export default defineComponent({
  name: "ReplayAdminView",
  props: {
    onSessionLost: { type: Function, required: true },
  },
  setup(props) {
    const toast = useToast();
    const { state: confirmState, confirm, onConfirm, onCancel } = useConfirm();

    const list = ref<ReplayAdminList | null>(null);
    const wanted = ref<WantedRaw | null>(null);
    const credits = ref<CreditsResponse | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);

    async function load(): Promise<void> {
      loading.value = true;
      error.value = null;
      try {
        // Credits are presentation-only — a failure there must not blank
        // the operational tables, so it degrades to null on its own.
        const [l, w, c] = await Promise.all([
          getReplayAdminList(),
          getReplayAdminWanted(),
          getReplayAdminCredits().catch(() => null),
        ]);
        list.value = l as ReplayAdminList;
        wanted.value = w as WantedRaw;
        credits.value = c as CreditsResponse | null;
      } catch (e) {
        if (isAuthError(e)) {
          props.onSessionLost();
          return;
        }
        error.value = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value = false;
      }
    }

    onMounted(() => {
      void load();
    });

    const contributors = computed(() => list.value?.contributors ?? []);
    const watermark = computed(() => list.value?.watermark ?? null);
    const stagedIds = computed(() =>
      contributors.value.filter((c) => c.stagedCount > 0).map((c) => c.anonId),
    );

    /** The stored ruleset parsed LENIENTLY for display; the server is
     *  the authority on save. */
    const wantedDoc = computed<WantedDoc | null>(() => {
      const raw = wanted.value;
      if (!raw?.exists || !raw.raw) return null;
      try {
        return JSON.parse(raw.raw) as WantedDoc;
      } catch {
        return null;
      }
    });
    const rules = computed(() => wantedDoc.value?.rules ?? []);

    // ── drain ────────────────────────────────────────────────────────
    function askDrain(ids: string[], all: boolean): void {
      if (!ids.length) return;
      confirm(
        {
          title: all ? "提取全部已暂存" : "提取归档",
          message: all
            ? `将把 ${ids.length} 位贡献者的暂存分片标记为已提取（请确认已先逐个下载归档）。规则计数不变，水位随之下降。`
            : `将把 ${ids.length} 位贡献者的暂存分片标记为已提取（请确认已先下载归档）。`,
          confirmLabel: "提取",
        },
        async () => {
          try {
            const r = (await replayAdminDrain({ anonIds: ids })) as DrainResult;
            toast.success(
              `${r.drained?.length ?? 0} 位贡献者已提取（${fmtBytes(r.bytes ?? 0)}）`,
            );
            await load();
          } catch (e) {
            if (isAuthError(e)) {
              props.onSessionLost();
              return;
            }
            toast.error(`提取失败：${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }

    // ── the wanted-ruleset editor ─────────────────────────────────────
    const wantedEditor = ref({ open: false, text: "", saving: false });

    function openWantedEditor(): void {
      const raw = wanted.value;
      wantedEditor.value.text = raw?.exists && raw.raw ? raw.raw : WANTED_TEMPLATE;
      wantedEditor.value.open = true;
    }

    function askSaveWanted(text: string, closeMessage?: string): void {
      confirm(
        {
          title: closeMessage ? "关闭征集" : "保存需求单",
          message: closeMessage
            ? "将写入空规则单（rules: []）——客户端将看到「征集已关闭」。原需求单会被覆盖。"
            : "将把编辑器中的 JSON 文本原样提交，服务端严格校验通过后才落库。",
          confirmLabel: closeMessage ? "关闭征集" : "保存",
          danger: Boolean(closeMessage),
        },
        async () => {
          wantedEditor.value.saving = true;
          try {
            // A rejected save comes back as HTTP 400 + {ok:false,error} —
            // the shared client throws that error text; the editor stays
            // open so the text being fixed is never lost.
            const r = (await saveReplayAdminWanted(text)) as WantedSaveOk;
            toast.success(closeMessage ?? `需求单已保存（v${r.rulesetVersion}，${r.rules} 条规则）`);
            wantedEditor.value.open = false;
            await load();
          } catch (e) {
            if (isAuthError(e)) {
              props.onSessionLost();
              return;
            }
            toast.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
          } finally {
            wantedEditor.value.saving = false;
          }
        },
      );
    }

    // ── rename ───────────────────────────────────────────────────────
    const rename = ref({ open: false, anonId: "", name: "", saving: false });

    function openRename(c: AdminContributor): void {
      rename.value.anonId = c.anonId;
      rename.value.name = c.creditedName;
      rename.value.open = true;
    }

    function askRename(): void {
      const name = rename.value.name.trim();
      if (name.length < 3 || name.length > 24) {
        toast.error("署名长度需在 3–24 个字符之间。");
        return;
      }
      confirm(
        {
          title: "修改署名",
          message: `将把 ${rename.value.anonId} 的署名改为「${name}」（发布贡献者名单以新署名为准）。`,
          confirmLabel: "保存",
          danger: false,
        },
        async () => {
          rename.value.saving = true;
          try {
            await replayAdminRename({ anonId: rename.value.anonId, name });
            toast.success(`署名已改为「${name}」`);
            rename.value.open = false;
            await load();
          } catch (e) {
            if (isAuthError(e)) {
              props.onSessionLost();
              return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            toast.error(
              msg === "unknown_contributor" ? "未知贡献者——请先刷新列表。" : `改名失败：${msg}`,
            );
          } finally {
            rename.value.saving = false;
          }
        },
      );
    }

    // ── backfill ─────────────────────────────────────────────────────
    const backfill = ref({ open: false, name: "", realm: "cn", membersText: "", saving: false });

    function openBackfill(): void {
      backfill.value.name = "";
      backfill.value.realm = "cn";
      backfill.value.membersText = "";
      backfill.value.open = true;
    }

    function parseMembers(text: string): BackfillMember[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("成员 JSON 无法解析（应为对象数组）。");
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("成员应为非空 JSON 数组。");
      }
      return parsed.map((raw) => {
        const m = raw as Record<string, unknown>;
        const sha256 = typeof m.sha256 === "string" ? m.sha256.toLowerCase() : "";
        const fileName = typeof m.fileName === "string" ? m.fileName : "";
        const sizeBytes = m.sizeBytes;
        if (!HEX64.test(sha256)) throw new Error("存在非法 sha256（需 64 位十六进制）。");
        if (!fileName) throw new Error("存在缺失的 fileName。");
        if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
          throw new Error("存在非法 sizeBytes（需正整数）。");
        }
        const member: BackfillMember = { sha256, fileName, sizeBytes };
        if (typeof m.ruleId === "string" && m.ruleId) member.ruleId = m.ruleId;
        return member;
      });
    }

    function askBackfill(): void {
      const name = backfill.value.name.trim();
      if (name.length < 3 || name.length > 24) {
        toast.error("署名长度需在 3–24 个字符之间。");
        return;
      }
      let members: BackfillMember[];
      try {
        members = parseMembers(backfill.value.membersText);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        return;
      }
      confirm(
        {
          title: "补录贡献",
          message: `将为「${name}」（${backfill.value.realm.toUpperCase()}）补记 ${members.length} 条已手动收集的录像（哈希重复的自动跳过）。`,
          confirmLabel: "补录",
          danger: false,
        },
        async () => {
          backfill.value.saving = true;
          try {
            const r = (await replayAdminBackfill({
              name,
              realm: backfill.value.realm,
              members,
            })) as BackfillOk;
            toast.success(`补录完成：采纳 ${r.credited ?? 0} 条，重复跳过 ${r.duplicates ?? 0} 条`);
            backfill.value.open = false;
            await load();
          } catch (e) {
            if (isAuthError(e)) {
              props.onSessionLost();
              return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            toast.error(
              msg === "identity_conflict"
                ? "身份冲突：该 (服务器, 署名) 已对应其他 anon id——改名请走「改名」。"
                : `补录失败：${msg}`,
            );
          } finally {
            backfill.value.saving = false;
          }
        },
      );
    }

    const tableSlots = {
      "cell-creditedName": ({ row }: { row: AdminContributor }) => (
        <div>
          <div>{row.creditedName}</div>
          <HkCopyBadge mono size="sm">
            {row.anonId}
          </HkCopyBadge>
        </div>
      ),
      "cell-realm": ({ row }: { row: AdminContributor }) => (
        <span>{(row.realm || "").toUpperCase()}</span>
      ),
      "cell-archiveBytes": ({ row }: { row: AdminContributor }) => (
        <span>{fmtBytes(row.archiveBytes)}</span>
      ),
      "cell-updatedAt": ({ row }: { row: AdminContributor }) => <span>{fmtTime(row.updatedAt)}</span>,
      "cell-actions": ({ row }: { row: AdminContributor }) => (
        <div class="erp-row-actions">
          <a href={replayAdminArchiveUrl(row.anonId)} target="_blank" rel="noreferrer">
            下载
          </a>
          <HButton
            size="sm"
            variant="secondary"
            disabled={row.stagedCount <= 0}
            onClick={() => askDrain([row.anonId], false)}
          >
            提取
          </HButton>
          <HButton size="sm" variant="ghost" onClick={() => openRename(row)}>
            改名
          </HButton>
        </div>
      ),
      "cell-count": ({ row }: { row: { name: string; realm: string; count: number } }) => (
        <span>{row.count}</span>
      ),
    };

    const ruleSlots = {
      "cell-id": ({ row }: { row: { id: string; note: string } }) => (
        <div>
          <div>{row.id}</div>
          {row.note ? <div class="erp-muted">{row.note}</div> : null}
        </div>
      ),
    };

    return () => (
      <div class="erp-view">
        {loading.value ? (
          <HCard>
            <HSkeletonList count={5} itemHeight="44px" />
          </HCard>
        ) : error.value ? (
          // App-wide error card standard (2026-10 direction): the raw
          // failure lives structured in the JSON pane, not a banner line.
          <HkErrorLanding variant="inline" title="加载失败" copyText={error.value}>
            {{
              default: () => <HkJsonTree value={{ message: error.value }} ariaLabel="raw error details" />,
            }}
          </HkErrorLanding>
        ) : (
          <>
            <div class="erp-head-row">
              <span class="erp-muted">
                水位 {fmtBytes(watermark.value?.stagedBytes)} / {fmtBytes(watermark.value?.limitBytes)}
                {" · "}
                {contributors.value.length} 位贡献者
                {" · "}
                需求单：
                {wanted.value?.exists
                  ? `${rules.value.length} 条规则${wantedDoc.value ? `（v${wantedDoc.value.rulesetVersion ?? 1}）` : ""}`
                  : "未设置（征集关闭）"}
              </span>
              <span class="erp-head-actions">
                <HButton size="sm" variant="ghost" onClick={() => void load()}>
                  刷新
                </HButton>
                <HButton size="sm" variant="secondary" onClick={openWantedEditor}>
                  编辑需求单…
                </HButton>
                <HButton
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    askSaveWanted(JSON.stringify({ rulesetVersion: 1, rules: [] }), "征集已关闭（空规则单已保存）")
                  }
                >
                  关闭征集…
                </HButton>
                <HButton size="sm" variant="secondary" onClick={openBackfill}>
                  补录贡献…
                </HButton>
                <HButton
                  size="sm"
                  variant="secondary"
                  disabled={stagedIds.value.length === 0}
                  onClick={() => askDrain(stagedIds.value, true)}
                >
                  提取全部已暂存…
                </HButton>
              </span>
            </div>

            <HCard>
              <h3 class="erp-section-title">需求单（服务端权威接受范围，摘要）</h3>
              <HTable
                columns={[
                  { key: "id", title: "规则", width: "180px" },
                  { key: "dims", title: "范围" },
                  { key: "maxCount", title: "上限", width: "90px" },
                ]}
                rows={rules.value.map((r) => ({
                  id: r.id ?? "（无 id）",
                  note: r.note ?? "",
                  dims: dimsOf(r),
                  maxCount: r.maxCount == null ? "∞" : String(r.maxCount),
                }))}
                rowKey="id"
                hover
              >
                {ruleSlots}
              </HTable>
              {!rules.value.length ? (
                <p class="erp-muted">需求单为空——征集处于关闭状态（FEEDBACK_KV 的 replays:wanted 未设置）。</p>
              ) : null}
            </HCard>

            <HCard>
              <h3 class="erp-section-title">贡献者（先下载归档，再提取）</h3>
              <HTable
                columns={[
                  { key: "creditedName", title: "署名", width: "220px" },
                  { key: "realm", title: "服务器", width: "90px" },
                  { key: "stagedCount", title: "暂存", width: "80px" },
                  { key: "archiveBytes", title: "体积", width: "100px" },
                  { key: "updatedAt", title: "最近活动", width: "160px" },
                  { key: "actions", title: "操作", width: "230px" },
                ]}
                rows={contributors.value as unknown as Record<string, unknown>[]}
                rowKey="anonId"
                hover
              >
                {tableSlots}
              </HTable>
              {!contributors.value.length ? <p class="erp-muted">还没有任何贡献者。</p> : null}
            </HCard>

            <HCard>
              <h3 class="erp-section-title">署名积分（发布名单的累计口径）</h3>
              <HTable
                columns={[
                  { key: "name", title: "署名", width: "220px" },
                  { key: "realm", title: "服务器", width: "120px" },
                  { key: "count", title: "累计采纳" },
                ]}
                rows={(credits.value?.contributors ?? []) as unknown as Record<string, unknown>[]}
                rowKey="name"
                hover
              >
                {tableSlots}
              </HTable>
              {!credits.value ? <p class="erp-muted">积分列表暂不可用（加载失败已跳过）。</p> : null}
            </HCard>
          </>
        )}

        {/* wanted editor */}
        <HModal
          modelValue={wantedEditor.value.open}
          onUpdate:modelValue={(v: boolean) => (wantedEditor.value.open = v)}
          title="编辑需求单（原始 JSON）"
          width="44rem"
        >
          {{
            default: () => (
              <div>
                <HTextarea
                  modelValue={wantedEditor.value.text}
                  onUpdate:modelValue={(v: string) => (wantedEditor.value.text = v)}
                  rows={16}
                  placeholder={WANTED_TEMPLATE}
                />
                <p class="erp-muted">POST 正文即此文本框原文；服务端校验失败会原样报错。</p>
              </div>
            ),
            footer: () => (
              <div class="erp-modal-actions">
                <HButton
                  variant="secondary"
                  onClick={() => (wantedEditor.value.open = false)}
                >
                  取消
                </HButton>
                <HButton
                  loading={wantedEditor.value.saving}
                  onClick={() => askSaveWanted(wantedEditor.value.text)}
                >
                  校验并保存
                </HButton>
              </div>
            ),
          }}
        </HModal>

        {/* rename */}
        <HModal
          modelValue={rename.value.open}
          onUpdate:modelValue={(v: boolean) => (rename.value.open = v)}
          title="修改署名"
          width="26rem"
        >
          {{
            default: () => (
              <div class="erp-form-col">
                <HInput modelValue={rename.value.anonId} onUpdate:modelValue={() => undefined} label="anon id" readonly />
                <HInput
                  modelValue={rename.value.name}
                  onUpdate:modelValue={(v: string) => (rename.value.name = v)}
                  label="署名（3–24 字符）"
                />
              </div>
            ),
            footer: () => (
              <div class="erp-modal-actions">
                <HButton variant="secondary" onClick={() => (rename.value.open = false)}>
                  取消
                </HButton>
                <HButton loading={rename.value.saving} onClick={askRename}>
                  保存
                </HButton>
              </div>
            ),
          }}
        </HModal>

        {/* backfill */}
        <HModal
          modelValue={backfill.value.open}
          onUpdate:modelValue={(v: boolean) => (backfill.value.open = v)}
          title="补录贡献（手动收集的录像）"
          width="36rem"
        >
          {{
            default: () => (
              <div class="erp-form-col">
                <HInput
                  modelValue={backfill.value.name}
                  onUpdate:modelValue={(v: string) => (backfill.value.name = v)}
                  label="署名（3–24 字符）"
                />
                <HkSelect
                  modelValue={backfill.value.realm}
                  onUpdate:modelValue={(v: string) => (backfill.value.realm = v)}
                  label="服务器"
                  options={REALM_OPTIONS}
                />
                <HTextarea
                  modelValue={backfill.value.membersText}
                  onUpdate:modelValue={(v: string) => (backfill.value.membersText = v)}
                  rows={8}
                  placeholder={'[{"sha256":"<64 hex>","fileName":"xxx.wowsreplay","sizeBytes":123456}]'}
                />
                <p class="erp-muted">
                  成员为 JSON 数组：{"{sha256, fileName, sizeBytes[, ruleId]}"}；同一哈希重复提交自动跳过。
                </p>
              </div>
            ),
            footer: () => (
              <div class="erp-modal-actions">
                <HButton variant="secondary" onClick={() => (backfill.value.open = false)}>
                  取消
                </HButton>
                <HButton loading={backfill.value.saving} onClick={askBackfill}>
                  补录
                </HButton>
              </div>
            ),
          }}
        </HModal>

        <HkConfirmDialog
          open={confirmState.open}
          onUpdate:open={(v: boolean) => (confirmState.open = v)}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          confirmVariant={confirmState.danger ? "danger" : "primary"}
          loading={confirmState.loading}
          onConfirm={() => void onConfirm()}
          onCancel={onCancel}
        />
      </div>
    );
  },
});
