/**
 * ReportWindowView — the AI battle report secondary window's whole UI
 * (E25): the app title bar (frameless window, same look as the main
 * shell) over the StaticReportPanel filling the rest of the window.
 *
 * The target (replay path + entity id) arrives twice: initially through
 * the URL query the Rust opener builds (`?replay=…&entity=…`), and on
 * every re-open through the `wowsp://report-params` event (the opener
 * re-targets an existing window instead of stacking new ones). 跳转
 * buttons emit `wowsp://report-seek` AT the main window — cross-window
 * step-through without this window knowing anything about the map.
 */
import { defineComponent, onMounted, onUnmounted, ref } from "vue";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";

import AppTitleBar from "@/components/layout/AppTitleBar";
import StaticReportPanel from "@/features/holographic/StaticReportPanel";
import { api, type StaticReport } from "@/api";
import { isNative } from "@/transport";
import { t as i18nT } from "@/i18n";
import "./ReportWindowView.scss";

/** The event the Rust opener emits to re-target this window. */
export const REPORT_PARAMS_EVENT = "wowsp://report-params";
/** The event this window emits at MAIN for playhead seeks. */
export const REPORT_SEEK_EVENT = "wowsp://report-seek";

interface ReportTarget {
  replayPath: string;
  entityId: number | null;
}

function targetFromQuery(): ReportTarget | null {
  const q = new URLSearchParams(window.location.search);
  const replayPath = q.get("replay");
  if (!replayPath) return null;
  const entity = q.get("entity");
  return { replayPath, entityId: entity != null ? Number(entity) : null };
}

export default defineComponent({
  name: "ReportWindowView",
  setup() {
    const report = ref<StaticReport | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    let target: ReportTarget | null = targetFromQuery();
    let unlisten: UnlistenFn | null = null;

    const load = async (t: ReportTarget) => {
      target = t;
      loading.value = true;
      error.value = null;
      try {
        report.value = await api.decisionStaticReport(t.replayPath, t.entityId);
      } catch (err) {
        error.value = String(err);
      } finally {
        loading.value = false;
      }
    };

    /** Cross-window step-through: send the seek to the MAIN window. */
    const seekTo = (tSec: number) => {
      if (!isNative()) return;
      void emitTo("main", REPORT_SEEK_EVENT, tSec).catch(() => undefined);
    };

    onMounted(() => {
      if (target) void load(target);
      if (isNative()) {
        void listen<ReportTarget>(REPORT_PARAMS_EVENT, (e) => {
          if (e.payload?.replayPath) void load(e.payload);
        }).then((fn) => (unlisten = fn));
      }
    });
    onUnmounted(() => unlisten?.());

    return () => (
      <div class="report-window">
        <AppTitleBar title={i18nT("replay.report.title")} subtitle="" />
        <div class="report-window__body">
          {error.value ? (
            <div class="report-window__error">{error.value}</div>
          ) : report.value ? (
            <StaticReportPanel
              report={report.value}
              loading={loading.value}
              onSeek={seekTo}
              onPick={(entityId) => target && void load({ ...target, entityId })}
            />
          ) : (
            <div class="report-window__placeholder">
              {loading.value ? i18nT("replay.report.loading") : i18nT("replay.report.noTarget")}
            </div>
          )}
        </div>
      </div>
    );
  },
});
