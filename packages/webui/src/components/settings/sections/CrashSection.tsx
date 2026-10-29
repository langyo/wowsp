/** Crash analysis (游戏崩溃分析) settings section. Top level: the
 *  safeguard switch, the LATEST crash stamp, the diagnostic findings
 *  and the recovery actions. The record history, the suspect list,
 *  the ignored-warning list and a record log window all live in
 *  secondary hikari windows. The crash PROMPT is a standard sticky
 *  toast from the store (shared stack with every other toast). */
import { computed, defineComponent, nextTick, onMounted, ref, watch } from "vue";

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

import { api, type CrashFinding, type GameCrashRecord, type SuspectMod } from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useCrashStore } from "@/stores/crash";
import ErrorCard from "@/components/base/ErrorCard";
import "./CrashSection.scss";

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
    case "missingModAsset":
      return t("crash.findings.missingModAsset", { asset: finding.detail ?? "?" });
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

/** The brief direct cause shown as a tag on every record card: the
 *  exception code when the evidence carried one, else the crash
 *  report summary line (e.g. "Unhandled exception"). */
function recordCause(record: GameCrashRecord): string | null {
  if (record.exceptionCode) return record.exceptionCode;
  const summary = (record.summary ?? "").trim();
  return summary.length > 0 ? summary : null;
}

export default defineComponent({
  name: "SettingsCrashSection",
  setup() {
    const crash = useCrashStore();
    const config = useConfigStore();
    const toast = useToast();

    /** The selected record id (defaults to the newest). */
    const selectedId = ref<string | null>(null);
    /** Secondary windows. */
    const recordsOpen = ref(false);
    const suspectsOpen = ref(false);
    const ignoredOpen = ref(false);
    const detailOpen = ref(false);
    /** The record-log window scroll pane (auto-scrolled to the tail). */
    const logPane = ref<HTMLElement | null>(null);
    /** The selected record analysis load failure (retryable). */
    const analysisError = ref("");
    /** The active install safe-mode state (live status row). */
    const safeMode = ref(false);
    /** The suspect pending a delete confirmation. */
    const deleteTarget = ref<string | null>(null);
    /** The one-click quarantine pass over the suspect window's rows. */
    const quarantineAllBusy = ref(false);

    /** Suspects the quarantine manifest does not cover yet — the bulk
     *  action quarantines exactly these, skipping rows already done. */
    const pendingSuspects = computed<SuspectMod[]>(() => {
      const suspects = selectedAnalysis.value?.suspects ?? [];
      const done = new Set(crash.quarantined.map((q) => q.name.toLowerCase()));
      return suspects.filter((s) => !done.has(s.name.toLowerCase()));
    });

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

    async function refreshQuarantined() {
      const root = gameRoot.value;
      if (!root) return;
      try {
        await crash.loadQuarantined(root);
      } catch {
        // No manifest yet.
      }
    }

    /** Everything refreshes after every recovery action: the records,
     *  the ignored list, the quarantined manifest, the safe-mode state
     *  AND a fresh analysis (the cached one describes the pre-action
     *  world). */
    async function refreshAll() {
      await crash.refreshHistory();
      await crash.loadIgnored();
      await refreshSafeMode();
      await refreshQuarantined();
      const record = selectedRecord.value;
      if (!record) return;
      analysisError.value = "";
      try {
        await crash.refreshAnalysis(record.id);
      } catch (e) {
        analysisError.value = e instanceof Error ? e.message : String(e);
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

    /** Open one record: select it for the findings AND open its log
     *  window (auto-scrolled to the last line). */
    async function openRecord(id: string) {
      selectedId.value = id;
      recordsOpen.value = false;
      await ensureAnalysis();
      detailOpen.value = true;
      await nextTick();
      const pane = logPane.value;
      if (pane) pane.scrollTop = pane.scrollHeight;
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
      const info = await crash.restart(selectedRecord.value?.gameRoot);
      if (info) toast.success(t("crash.section.restart") + " (pid " + info.pid + ")");
    }

    async function safeRestart() {
      const root = selectedRecord.value?.gameRoot;
      if (!root) {
        toast.info(t("crash.toast.safeRestartFallback"));
        return;
      }
      await crash.safeModeAndRestart(root);
    }

    async function quarantine(name: string) {
      const record = selectedRecord.value;
      try {
        await crash.quarantine(name, record?.id, record?.gameRoot);
        toast.success(name + " — " + t("crash.modlist.quarantinedBadge"));
        await refreshAll();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    /** Quarantine every pending suspect in one pass (the suspect
     *  window's footer button). Each row rides the guarded single-entry
     *  command — game-running refusals land per row; the pass reports
     *  the count and surfaces the first refusal instead of stopping. */
    async function quarantineAll() {
      const targets = pendingSuspects.value;
      const record = selectedRecord.value;
      if (targets.length === 0 || quarantineAllBusy.value) return;
      quarantineAllBusy.value = true;
      let done = 0;
      let firstError: string | null = null;
      try {
        for (const s of targets) {
          try {
            await crash.quarantine(s.name, record?.id, record?.gameRoot);
            done += 1;
          } catch (e) {
            firstError ??= e instanceof Error ? e.message : String(e);
          }
        }
      } finally {
        quarantineAllBusy.value = false;
      }
      if (done > 0) {
        toast.success(t("crash.suspects.quarantineAllDone", { count: done }));
        await refreshAll();
      }
      if (firstError) toast.error(firstError);
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
        await refreshAll();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    async function ignore(name: string) {
      try {
        await crash.ignoreSuspect(name);
        toast.success(t("crash.suspects.ignoreDone"));
        await refreshAll();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    async function restoreIgnored(name: string) {
      try {
        await crash.restoreSuspect(name);
        toast.success(t("crash.suspects.restoreDone"));
        await refreshAll();
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

    /** Reset every record in one pass (new -> dismissed): the per-boot
     *  re-toast stops, the history list stays. The success toast answers
     *  the flipped count; refusals toast here like every other action. */
    async function resetAll() {
      try {
        const count = await crash.dismissAll();
        if (count > 0) toast.success(t("crash.section.resetDone", { count }));
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
                onClick={() => void refreshAll()}
              >
                <RefreshCw size={14} />
                {t("crash.section.refresh")}
              </HkButton>
            </div>

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

            <div class="crash-section__latest">
              <span class="crash-section__latest-label">{t("crash.section.latest")}</span>
              <span class="crash-section__latest-value">
                {record ? formatTime(record.detectedAt) : t("crash.section.noCrashes")}
              </span>
              <span class="crash-section__spacer" />
              {record ? (
                <HkButton size="sm" onClick={() => (recordsOpen.value = true)}>
                  {t("crash.section.openRecords")} ({crash.history.length})
                </HkButton>
              ) : null}
              {analysis && analysis.suspects.length > 0 ? (
                <HkButton size="sm" onClick={() => (suspectsOpen.value = true)}>
                  {t("crash.section.suspects")} ({analysis.suspects.length})
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

                    <div class="crash-section__actions">
                      <HkButton size="sm" variant="secondary" onClick={() => void safeRestart()}>
                        <ShieldAlert size={14} />
                        {t("crash.toast.safeRestart")}
                      </HkButton>
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
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p class="crash-section__empty">{t("crash.section.empty")}</p>
            )}
          </HkSettingsGroup>

          {/* ── record history window: cards carry the direct cause tag ── */}
          <HkModal
            modelValue={recordsOpen.value}
            onUpdate:modelValue={(v: boolean) => (recordsOpen.value = v)}
            title={t("crash.section.recordsTitle")}
            width="34rem"
            footerActions={[
              {
                label: t("crash.section.resetAll"),
                variant: "outline",
                loading: crash.resetting,
                disabled: crash.resetting || !crash.history.some((r) => r.status === "new"),
                onClick: () => void resetAll(),
              },
            ]}
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
                  onClick={() => void openRecord(r.id)}
                >
                  <span class="crash-section__record-head">
                    <span class="crash-section__record-time">
                      {formatTime(r.detectedAt)}
                    </span>
                    {recordCause(r) ? (
                      <HkTag
                        variant={r.exceptionCode ? "danger" : "default"}
                        size="sm"
                      >
                        {recordCause(r)}
                      </HkTag>
                    ) : null}
                  </span>
                  <span class="crash-section__record-meta">
                    {r.imageName} (pid {r.pid})
                    {" · " + sourceLabel(r.source)}
                  </span>
                </button>
              ))}
            </div>
          </HkModal>

          {/* ── one record detail window: the logs, tail-first ── */}
          <HkModal
            modelValue={detailOpen.value}
            onUpdate:modelValue={(v: boolean) => (detailOpen.value = v)}
            title={t("crash.section.recordDetail")}
            width="46rem"
          >
            <div ref={(el: unknown) => (logPane.value = el as HTMLElement | null)} class="crash-section__detail-logs">
              {record ? (
                <p class="crash-section__meta">
                  {formatTime(record.detectedAt)}
                  {record.gameRoot ? " · " + record.gameRoot : ""}
                  {" · " + sourceLabel(record.source)}
                </p>
              ) : null}
              {analysis ? (
                [...analysis.gameLogs, ...analysis.appLogs].map((log) => (
                  <section key={log.path} class="crash-section__log">
                    <h4 class="crash-section__log-name">{log.name}</h4>
                    {log.highlights.length > 0 ? (
                      <ul class="crash-section__log-highlights">
                        {log.highlights.map((line) => (
                          <li key={line} data-hint-overflow={line}>
                            <code>{line}</code>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <pre class="crash-section__log-tail">{log.tail}</pre>
                  </section>
                ))
              ) : (
                <div class="crash-section__loading">
                  <HkSpinner size={18} />
                </div>
              )}
              {analysis ? (
                <p class="crash-section__meta">
                  {t("crash.section.modsInventory")}: {analysis.modsInventory.length}
                  {analysis.currentBuild
                    ? " · " + t("crash.section.currentBuild") + ": " + analysis.currentBuild
                    : ""}
                </p>
              ) : null}
            </div>
          </HkModal>

          {/* ── suspect list window: the actionable rows ─────────────── */}
          <HkModal
            modelValue={suspectsOpen.value}
            onUpdate:modelValue={(v: boolean) => (suspectsOpen.value = v)}
            title={t("crash.section.suspects")}
            width="44rem"
            footerActions={[
              {
                label:
                  t("crash.suspects.quarantineAll") +
                  (pendingSuspects.value.length > 0
                    ? " (" + pendingSuspects.value.length + ")"
                    : ""),
                variant: "outline",
                loading: quarantineAllBusy.value,
                disabled:
                  quarantineAllBusy.value || pendingSuspects.value.length === 0,
                onClick: () => void quarantineAll(),
              },
            ]}
          >
            {analysis && analysis.suspects.length > 0 ? (
              <ul class="crash-section__suspects">
                {analysis.suspects.map((s) => {
                  const quarantinedNow = crash.quarantined.some(
                    (q) => q.name.toLowerCase() === s.name.toLowerCase(),
                  );
                  const busy = crash.quarantineBusy.has(s.name);
                  return (
                    <li key={s.name} class="crash-section__suspect">
                      <div class="crash-section__suspect-row">
                        <span
                          class="crash-section__suspect-name"
                          data-hint-overflow={s.name}
                        >
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
                            <li key={line} data-hint-overflow={line}>
                              <code>{line}</code>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p class="crash-section__empty">{t("crash.suspects.empty")}</p>
            )}
          </HkModal>

          {/* ── ignored warnings window (restore = undo) ──────────────── */}
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
                    <span class="crash-section__ignored-name" data-hint-overflow={i.name}>
                      {i.name}
                    </span>
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