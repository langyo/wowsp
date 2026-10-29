/** Crash analysis (游戏崩溃分析) settings section — the watchdog
 *  records and their post-mortem. The section keeps its top level to
 *  the essentials (the safeguard switch and the LATEST crash stamp);
 *  the record history, the raw logs and the dismissed-warning list
 *  live in secondary hikari windows, and every suspect row carries
 *  right-aligned 隔离 / 删除 / 忽略 actions. Parsing recent crashes is
 *  automatic (startup catch-up + the safeguard toggle), so no manual
 *  scan button is offered. The store behind it is stores/crash.ts. */
import { computed, defineComponent, onMounted, ref, watch } from "vue";

import {
  HkAlert,
  HkButton,
  HkConfirmDialog,
  HkModal,
  HkSettingsGroup,
  HkSpinner,
  HkSwitch,
  HkTag,
  useToast,
} from "@celestia-island/hikari";
import { BellOff, FileDown, RefreshCw, ShieldAlert, Trash2 } from "@lucide/vue";

import { api, type CrashFinding, type GameCrashRecord } from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useCrashStore } from "@/stores/crash";
import ErrorCard from "@/components/base/ErrorCard";
import "./CrashSection.scss";

/** The findings whose i18n message carries a placeholder the finding
 *  detail fills; everything else renders the plain message. */
function findingText(finding: CrashFinding): string {
  switch (finding.code) {
    case "exceptionUnknown":
      return t("crash.findings.exceptionUnknown", { code: finding.detail ?? "?" });
    case "faultingModule":
      return t("crash.findings.faultingModule", { module: finding.detail ?? "?" });
    case "gameLogErrors":
      return t("crash.findings.gameLogErrors", { count: finding.detail ?? "0" });
    case "recentModChanges":
      return t("crash.findings.recentModChanges", { mods: finding.detail ?? "" });
    case "danglingUiReference":
      return t("crash.findings.danglingUiReference", { url: finding.detail ?? "?" });
    default:
      return t("crash.findings." + finding.code);
  }
}

function sourceLabel(source: string): string {
  if (source === "event-log") return t("crash.section.source.eventLog");
  if (source === "wer-report") return t("crash.section.source.werReport");
  if (source === "game-report") return t("crash.section.source.gameReport");
  return t("crash.section.source.crashDump");
}

export default defineComponent({
  name: "SettingsCrashSection",
  setup() {
    const crash = useCrashStore();
    const config = useConfigStore();
    const toast = useToast();

    /** The selected record id (defaults to the newest). */
    const selectedId = ref<string | null>(null);
    /** Secondary windows: record history / ignored warnings / raw logs. */
    const recordsOpen = ref(false);
    const ignoredOpen = ref(false);
    const rawOpen = ref(false);
    /** The selected record analysis load failure (retryable). */
    const analysisError = ref("");
    /** The active install safe-mode state (live status row). */
    const safeMode = ref(false);
    /** The suspect pending a delete confirmation. */
    const deleteTarget = ref<string | null>(null);

    const selectedRecord = computed<GameCrashRecord | null>(
      () =>
        crash.history.find((r) => r.id === selectedId.value) ??
        crash.history[0] ??
        null,
    );
    const selectedAnalysis = computed(() =>
      selectedRecord.value ? crash.analysisFor(selectedRecord.value.id) : undefined,
    );
    const gameRoot = computed(
      () => selectedRecord.value?.gameRoot ?? config.activeInstall?.path ?? null,
    );

    async function refreshSafeMode() {
      const root = gameRoot.value;
      if (!root) {
        safeMode.value = false;
        return;
      }
      try {
        safeMode.value = await api.modHubSafeMode(root);
      } catch {
        safeMode.value = false;
      }
    }

    /** Load (or reuse) the selected record analysis; quiet failures land
     *  in the retryable error card. */
    async function ensureAnalysis() {
      const record = selectedRecord.value;
      if (!record || crash.analysisFor(record.id)) return;
      analysisError.value = "";
      try {
        await crash.analyze(record.id);
      } catch (e) {
        analysisError.value = e instanceof Error ? e.message : String(e);
      }
    }

    /** The quarantined manifest is PER INSTALL — this surface loads the
     *  selected record root, never whatever the mod hub last loaded. */
    async function refreshQuarantined() {
      const root = gameRoot.value;
      if (!root) return;
      try {
        await crash.loadQuarantined(root);
      } catch {
        // No manifest yet.
      }
    }

    onMounted(async () => {
      await crash.refreshHistory();
      void crash.loadIgnored();
      void refreshSafeMode();
      void ensureAnalysis();
      void refreshQuarantined();
    });

    watch(selectedRecord, (record, previous) => {
      if (record?.id === previous?.id) return;
      void ensureAnalysis();
      void refreshSafeMode();
      void refreshQuarantined();
    });

    function select(id: string) {
      selectedId.value = id;
      recordsOpen.value = false;
    }

    /** Forget the cached analysis and reload it (after an ignore /
     *  delete the findings and suspects must reflect the new state). */
    async function reloadAnalysis() {
      const record = selectedRecord.value;
      if (!record) return;
      analysisError.value = "";
      try {
        await crash.refreshAnalysis(record.id);
      } catch (e) {
        analysisError.value = e instanceof Error ? e.message : String(e);
      }
    }

    async function exportReport() {
      const record = selectedRecord.value;
      if (!record) return;
      try {
        await crash.exportReport(record.id);
        toast.success(t("crash.section.exportDone"));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    async function restart() {
      const record = selectedRecord.value;
      const info = await crash.restart(record?.gameRoot);
      if (info) toast.success(t("crash.section.restart") + " (pid " + info.pid + ")");
    }

    async function quarantine(name: string) {
      const record = selectedRecord.value;
      try {
        await crash.quarantine(name, record?.id, record?.gameRoot);
        toast.success(name + " — " + t("crash.modlist.quarantinedBadge"));
        await reloadAnalysis();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    function requestDelete(name: string) {
      deleteTarget.value = name;
    }

    async function doDelete() {
      const name = deleteTarget.value;
      deleteTarget.value = null;
      if (!name) return;
      try {
        await crash.deleteEntry(name, selectedRecord.value?.gameRoot);
        toast.success(name + " — " + t("crash.suspects.deleteDone"));
        await reloadAnalysis();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    async function ignore(name: string) {
      try {
        await crash.ignoreSuspect(name);
        toast.success(t("crash.suspects.ignoreDone"));
        await reloadAnalysis();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    async function restoreIgnored(name: string) {
      try {
        await crash.restoreSuspect(name);
        toast.success(t("crash.suspects.restoreDone"));
        await reloadAnalysis();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    async function toggleSafeguard(enabled: boolean) {
      try {
        await crash.setSafeguard(enabled);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    function formatTime(iso: string): string {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
    }

    const severityVariant = (s: string) => (s === "critical" ? "danger" : "default");

    return () => {
      const record = selectedRecord.value;
      const analysis = selectedAnalysis.value;
      return (
        <>
          <HkSettingsGroup>
            <div class="settings-modal__packs-head">
              <h2 class="hk-settings-group-title">{t("crash.section.title")}</h2>
              <HkButton
                size="sm"
                loading={crash.historyLoading}
                onClick={() => void crash.refreshHistory()}
              >
                <RefreshCw size={14} />
                {t("crash.section.refresh")}
              </HkButton>
            </div>

            {/* the safeguard switch row */}
            <div class="crash-section__safeguard">
              <div class="crash-section__safeguard-text">
                <span class="crash-section__safeguard-title">
                  {t("crash.safeguard.title")}
                </span>
                <span class="crash-section__safeguard-hint">
                  {t("crash.safeguard.hint")}
                </span>
              </div>
              <HkSwitch
                modelValue={crash.safeguard}
                disabled={crash.safeguardBusy}
                onUpdate:modelValue={(v: boolean) => void toggleSafeguard(v)}
              />
            </div>

            {/* the latest crash row: the section keeps only the stamp */}
            <div class="crash-section__latest">
              <span class="crash-section__latest-label">{t("crash.section.latest")}</span>
              <span class="crash-section__latest-value">
                {record ? formatTime(record.detectedAt) : t("crash.section.noCrashes")}
              </span>
              <span class="crash-section__spacer" />
              {crash.history.length > 0 ? (
                <HkButton size="sm" onClick={() => (recordsOpen.value = true)}>
                  {t("crash.section.openRecords")} ({crash.history.length})
                </HkButton>
              ) : null}
              <HkButton size="sm" variant="ghost" onClick={() => (ignoredOpen.value = true)}>
                {t("crash.section.ignored")} ({crash.ignored.length})
              </HkButton>
            </div>

            {record ? (
              <div class="crash-section__detail">
                <p class="crash-section__meta">
                  {t("crash.section.recordTime", { time: formatTime(record.detectedAt) })}
                  {record.gameRoot ? " · " + record.gameRoot : ""}
                  {record.gameBuild ? " · build " + record.gameBuild : ""}
                  {" · " + sourceLabel(record.source)}
                  {record.exceptionCode ? " · " + record.exceptionCode : ""}
                </p>
                {safeMode.value ? (
                  <HkAlert
                    variant="info"
                    size="sm"
                    message={t("crash.section.safeModeOn")}
                  />
                ) : null}

                {analysisError.value ? (
                  <ErrorCard
                    error={analysisError.value}
                    description={t("crash.section.findings")}
                    retry={() => void ensureAnalysis()}
                  />
                ) : !analysis ? (
                  <div class="crash-section__loading">
                    <HkSpinner size={18} />
                  </div>
                ) : (
                  <>
                    {/* findings */}
                    <section class="crash-section__block">
                      <h3 class="crash-section__block-title">
                        {t("crash.section.findings")}
                      </h3>
                      <ul class="crash-section__findings">
                        {analysis.findings.map((f) => (
                          <li key={f.code + String(f.detail)} class="crash-section__finding">
                            <HkTag variant={severityVariant(f.severity)} size="sm">
                              {t("crash.severity." + f.severity)}
                            </HkTag>
                            <span class="hk-selectable crash-section__finding-text">
                              {findingText(f)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>

                    {/* suspects: right-aligned actions */}
                    {analysis.suspects.length > 0 ? (
                      <section class="crash-section__block">
                        <h3 class="crash-section__block-title">
                          {t("crash.section.suspects")}
                        </h3>
                        <ul class="crash-section__suspects">
                          {analysis.suspects.map((s) => {
                            const quarantinedNow = crash.quarantined.some(
                              (q) => q.name.toLowerCase() === s.name.toLowerCase(),
                            );
                            const busy = crash.quarantineBusy.has(s.name);
                            return (
                              <li key={s.name} class="crash-section__suspect">
                                <div class="crash-section__suspect-row">
                                  <span class="crash-section__suspect-name">
                                    {s.name}
                                  </span>
                                  <HkTag variant="default" size="sm">
                                    {t("crash.suspects.evidence." + s.evidence)}
                                  </HkTag>
                                  {quarantinedNow ? (
                                    <HkTag variant="default" size="sm">
                                      {t("crash.modlist.quarantinedBadge")}
                                    </HkTag>
                                  ) : null}
                                  <span class="crash-section__spacer" />
                                  <div class="crash-section__suspect-actions">
                                    {quarantinedNow ? (
                                      <HkButton
                                        size="sm"
                                        variant="secondary"
                                        disabled={busy}
                                        onClick={() => void restoreIgnored(s.name)}
                                      >
                                        {t("crash.suspects.restore")}
                                      </HkButton>
                                    ) : (
                                      <HkButton
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void quarantine(s.name)}
                                      >
                                        <ShieldAlert size={12} />
                                        {t("crash.suspects.quarantine")}
                                      </HkButton>
                                    )}
                                    <HkButton
                                      size="sm"
                                      variant="danger"
                                      disabled={busy}
                                      onClick={() => requestDelete(s.name)}
                                    >
                                      <Trash2 size={12} />
                                      {t("crash.suspects.delete")}
                                    </HkButton>
                                    <HkButton
                                      size="sm"
                                      variant="ghost"
                                      disabled={busy}
                                      onClick={() => void ignore(s.name)}
                                    >
                                      <BellOff size={12} />
                                      {t("crash.suspects.ignore")}
                                    </HkButton>
                                  </div>
                                </div>
                                {s.logLines.length > 0 ? (
                                  <ul class="hk-selectable crash-section__suspect-lines">
                                    {s.logLines.map((line) => (
                                      <li key={line}>
                                        <code>{line}</code>
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    ) : null}

                    {/* actions */}
                    <div class="crash-section__actions">
                      <HkButton
                        size="sm"
                        loading={crash.exportingId === record.id}
                        disabled={crash.exportingId === record.id}
                        onClick={() => void exportReport()}
                      >
                        <FileDown size={14} />
                        {t("crash.section.export")}
                      </HkButton>
                      <HkButton
                        size="sm"
                        variant="secondary"
                        loading={crash.restarting}
                        disabled={crash.restarting}
                        onClick={() => void restart()}
                      >
                        {t("crash.section.restart")}
                      </HkButton>
                      <span class="crash-section__spacer" />
                      <HkButton size="sm" variant="ghost" onClick={() => (rawOpen.value = true)}>
                        {t("crash.section.rawLogs")}
                      </HkButton>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p class="crash-section__empty">{t("crash.section.empty")}</p>
            )}
          </HkSettingsGroup>

          {/* the record history window */}
          <HkModal
            modelValue={recordsOpen.value}
            onUpdate:modelValue={(v: boolean) => (recordsOpen.value = v)}
            title={t("crash.section.recordsTitle")}
            width="34rem"
          >
            <div class="crash-section__records">
              {crash.history.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  class={{
                    "crash-section__record": true,
                    "is-selected": r.id === record?.id,
                    "is-dismissed": r.status === "dismissed",
                  }}
                  onClick={() => select(r.id)}
                >
                  <span class="crash-section__record-time">
                    {formatTime(r.detectedAt)}
                  </span>
                  <span class="crash-section__record-name">
                    {r.imageName} (pid {r.pid})
                  </span>
                  <span class="crash-section__record-meta">
                    {sourceLabel(r.source)}
                    {r.exceptionCode ? " · " + r.exceptionCode : ""}
                  </span>
                </button>
              ))}
            </div>
          </HkModal>

          {/* the ignored-warnings window (restore = undo the dismissal) */}
          <HkModal
            modelValue={ignoredOpen.value}
            onUpdate:modelValue={(v: boolean) => (ignoredOpen.value = v)}
            title={t("crash.section.ignored")}
            width="34rem"
          >
            {crash.ignored.length === 0 ? (
              <p class="crash-section__empty">{t("crash.section.ignoredEmpty")}</p>
            ) : (
              <ul class="crash-section__ignored">
                {crash.ignored.map((i) => (
                  <li key={i.name} class="crash-section__ignored-row">
                    <span class="crash-section__ignored-name">{i.name}</span>
                    <span class="crash-section__ignored-time">
                      {formatTime(i.ignoredAt)}
                    </span>
                    <span class="crash-section__spacer" />
                    <HkButton size="sm" variant="secondary" onClick={() => void restoreIgnored(i.name)}>
                      {t("crash.section.restoreWarning")}
                    </HkButton>
                  </li>
                ))}
              </ul>
            )}
          </HkModal>

          {/* the raw logs window */}
          <HkModal
            modelValue={rawOpen.value}
            onUpdate:modelValue={(v: boolean) => (rawOpen.value = v)}
            title={t("crash.section.rawLogsTitle")}
            width="48rem"
          >
            {analysis ? (
              <div class="hk-selectable crash-section__raw">
                {[...analysis.gameLogs, ...analysis.appLogs].map((log) => (
                  <section key={log.path} class="crash-section__log">
                    <h4 class="crash-section__log-name">{log.name}</h4>
                    {log.highlights.length > 0 ? (
                      <ul class="crash-section__log-highlights">
                        {log.highlights.map((line) => (
                          <li key={line}>
                            <code>{line}</code>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <pre class="crash-section__log-tail">{log.tail}</pre>
                  </section>
                ))}
                <p class="crash-section__meta">
                  {t("crash.section.modsInventory")}: {analysis.modsInventory.length}
                  {analysis.currentBuild
                    ? " · " + t("crash.section.currentBuild") + ": " + analysis.currentBuild
                    : ""}
                </p>
              </div>
            ) : null}
          </HkModal>

          <HkConfirmDialog
            open={deleteTarget.value !== null}
            title={t("crash.suspects.confirmDeleteTitle")}
            message={t("crash.suspects.confirmDeleteMessage", {
              name: deleteTarget.value ?? "",
            })}
            confirmLabel={t("crash.suspects.delete")}
            onConfirm={() => void doDelete()}
            onUpdate:open={(v: boolean) => {
              if (!v) deleteTarget.value = null;
            }}
          />
        </>
      );
    };
  },
});