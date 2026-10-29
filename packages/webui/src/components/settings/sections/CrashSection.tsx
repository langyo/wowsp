/** Crash analysis (游戏崩溃分析) settings section — the watchdog records
 *  list plus the per-record deep dive: findings with severity chips, the
 *  suspect mods (the crash-localization answer, quarantinable in place),
 *  the game-side and WoWSP log excerpts, and the export / restart
 *  actions. The store behind it is stores/crash.ts; the toast card
 *  deep-links here via settingsUi.show("crash"). */
import { computed, defineComponent, onMounted, ref, watch } from "vue";

import { HkButton, HkSettingsGroup, HkSpinner, HkSwitch, useToast } from "@celestia-island/hikari";
import { FileDown, RefreshCw, RotateCcw, ShieldAlert, Zap } from "@lucide/vue";

import { api, type CrashFinding, type GameCrashRecord } from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useCrashStore } from "@/stores/crash";
import ErrorCard from "@/components/base/ErrorCard";
import "./CrashSection.scss";

/** The findings whose i18n message carries a placeholder the finding
 *  detail fills; everything else renders the plain message (and a
 *  raw-detail line when one exists). The key path is assembled by
 *  concatenation — the finding codes ARE the message keys. */
function findingText(finding: CrashFinding): string {
  switch (finding.code) {
    case "exceptionUnknown":
      return t("crash.findings.exceptionUnknown", { code: finding.detail ?? "?" });
    case "faultingModule":
      return t("crash.findings.faultingModule", { module: finding.detail ?? "?" });
    case "gameLogErrors":
      return t("crash.findings.gameLogErrors", { count: finding.detail ?? "0" });
    case "danglingUiReference":
      return t("crash.findings.danglingUiReference", { url: finding.detail ?? "?" });
    case "recentModChanges":
      return t("crash.findings.recentModChanges", { mods: finding.detail ?? "" });
    default:
      return t("crash.findings." + finding.code);
  }
}

/** The record source label — the wire tags are kebab ("event-log") while
 *  the message keys are camel, so the mapping is explicit (a string mash
 *  would miss the keys and render the raw key path). */
function sourceLabel(source: string): string {
  if (source === "event-log") return t("crash.section.source.eventLog");
  if (source === "wer-report") return t("crash.section.source.werReport");
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
    /** The selected record analysis load failure (retryable). */
    const analysisError = ref("");
    /** The active install safe-mode state (info row). */
    const safeMode = ref(false);
    /** Log-excerpt blocks the user expanded (file path set). */
    const expandedLogs = ref(new Set<string>());

    const selectedRecord = computed<GameCrashRecord | null>(
      () =>
        crash.history.find((r) => r.id === selectedId.value) ??
        crash.history[0] ??
        null,
    );
    const selectedAnalysis = computed(() =>
      selectedRecord.value ? crash.analysisFor(selectedRecord.value.id) : undefined,
    );

    /** The install the per-install reads target (the selected record
     *  root, else the active install). */
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

    onMounted(async () => {
      await crash.refreshHistory();
      void refreshSafeMode();
      void ensureAnalysis();
      void refreshQuarantined();
    });

    // Selection changes drive the lazy analysis + safe-mode read.
    watch(selectedRecord, (record, previous) => {
      if (record?.id === previous?.id) return;
      void ensureAnalysis();
      void refreshSafeMode();
      void refreshQuarantined();
    });

    /** The quarantined manifest is PER INSTALL — this surface loads the
     *  selected record's root, never whatever the mod hub last loaded. */
    async function refreshQuarantined() {
      const root = gameRoot.value;
      if (!root) return;
      try {
        await crash.loadQuarantined(root);
      } catch {
        // No manifest yet — the quarantined list stays as-is.
      }
    }

    function select(id: string) {
      selectedId.value = id;
    }

    function toggleLog(path: string) {
      const next = new Set(expandedLogs.value);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      expandedLogs.value = next;
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
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    async function restore(name: string) {
      const record = selectedRecord.value;
      try {
        await crash.restore(name, record?.gameRoot);
        toast.success(name + " — " + t("crash.suspects.restore"));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }

    /** The manual catch-up: parse whatever recent crash evidence the
     *  history has not recorded yet (crashes from before the app opened). */
    async function scanRecent() {
      try {
        const count = await crash.scanRecent();
        if (count > 0) {
          toast.success(t("crash.safeguard.scanDone", { count: String(count) }));
        } else {
          toast.info(t("crash.safeguard.scanNone"));
        }
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

    return () => {
      const record = selectedRecord.value;
      const analysis = selectedAnalysis.value;
      const quarantined = crash.quarantined;
      return (
        <HkSettingsGroup>
          <div class="settings-modal__packs-head">
            <h2 class="hk-settings-group-title">
              <Zap size={16} /> {t("crash.section.title")}
            </h2>
            <HkButton
              size="sm"
              loading={crash.historyLoading}
              onClick={() => void crash.refreshHistory()}
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
            <HkButton
              size="sm"
              variant="outline"
              loading={crash.scanning}
              disabled={crash.scanning || !crash.safeguard}
              onClick={() => void scanRecent()}
            >
              {t("crash.safeguard.scan")}
            </HkButton>
          </div>

          {crash.history.length === 0 ? (
            <p class="crash-section__empty">{t("crash.section.empty")}</p>
          ) : (
            <div class="crash-section">
              {/* record list */}
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
                      {new Date(r.detectedAt).toLocaleString()}
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

              {/* detail pane */}
              {record ? (
                <div class="crash-section__detail">
                  <p class="crash-section__detail-head">
                    {t("crash.section.recordTime", {
                      time: new Date(record.detectedAt).toLocaleString(),
                    })}
                    {record.gameRoot ? " · " + record.gameRoot : ""}
                    {record.gameBuild ? " · build " + record.gameBuild : ""}
                  </p>
                  {safeMode.value ? (
                    <p class="crash-section__safemode">
                      <ShieldAlert size={14} /> {t("crash.section.safeModeOn")}
                    </p>
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
                            <li
                              key={f.code + String(f.detail)}
                              class={[
                                "crash-section__finding",
                                "is-" + f.severity,
                              ]}
                            >
                              <span class={"crash-section__chip crash-section__chip--" + f.severity}>
                                {t("crash.severity." + f.severity)}
                              </span>
                              <span class="crash-section__finding-text">{findingText(f)}</span>
                              {f.code === "dumpAvailable" && f.detail ? (
                                <code class="crash-section__raw">{f.detail}</code>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>

                      {/* suspects */}
                      {analysis.suspects.length > 0 ? (
                        <section class="crash-section__block">
                          <h3 class="crash-section__block-title">
                            {t("crash.section.suspects")}
                          </h3>
                          <ul class="crash-section__suspects">
                            {analysis.suspects.map((s) => {
                              const quarantinedNow = quarantined.some(
                                (q) => q.name.toLowerCase() === s.name.toLowerCase(),
                              );
                              const busy = crash.quarantineBusy.has(s.name);
                              return (
                                <li key={s.name} class="crash-section__suspect">
                                  <div class="crash-section__suspect-row">
                                    <span class="crash-section__suspect-name">{s.name}</span>
                                    <span class="crash-section__badge">
                                      {t("crash.suspects.evidence." + s.evidence)}
                                    </span>
                                    {quarantinedNow ? (
                                      <>
                                        <span class="crash-section__badge is-quarantined">
                                          {t("crash.modlist.quarantinedBadge")}
                                        </span>
                                        <HkButton
                                          size="sm"
                                          variant="secondary"
                                          disabled={busy}
                                          onClick={() => void restore(s.name)}
                                        >
                                          <RotateCcw size={12} />
                                          {t("crash.suspects.restore")}
                                        </HkButton>
                                      </>
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
                                  </div>
                                  {s.logLines.length > 0 ? (
                                    <ul class="crash-section__suspect-lines">
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

                      {/* log excerpts */}
                      {[...analysis.gameLogs, ...analysis.appLogs].map((log) => {
                        const open = expandedLogs.value.has(log.path);
                        return (
                          <section key={log.path} class="crash-section__block">
                            <button
                              type="button"
                              class="crash-section__log-toggle"
                              onClick={() => toggleLog(log.path)}
                            >
                              {open ? "▾" : "▸"} {log.name}
                              <span class="crash-section__log-meta">
                                {log.highlights.length > 0
                                  ? " · " + log.highlights.length
                                  : ""}
                              </span>
                            </button>
                            {open ? (
                              <div class="crash-section__log-body">
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
                              </div>
                            ) : null}
                          </section>
                        );
                      })}

                      {/* meta */}
                      <p class="crash-section__meta">
                        {t("crash.section.modsInventory")}: {analysis.modsInventory.length}
                        {analysis.currentBuild
                          ? " · " + t("crash.section.currentBuild") + ": " + analysis.currentBuild
                          : ""}
                      </p>

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
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </HkSettingsGroup>
      );
    };
  },
});