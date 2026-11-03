import { defineComponent, ref, type PropType } from "vue";
import { Download } from "@lucide/vue";
import { HkButton, HkModal, HkSpinner } from "@celestia-island/hikari";

import type { StaticReport } from "@/api";
import ErrorCard from "@/components/base/ErrorCard";
import { t } from "@/i18n";
import StaticReportPanel from "@/features/holographic/StaticReportPanel";
import "./StaticReportModal.scss";

/**
 * StaticReportModal — the AI 战报 as a first-class window (2026-11-03
 * extraction): the E25 report had been living in a hand-rolled
 * `.replay-view__modal` overlay with a custom head, no open animation and
 * none of the hikari motion/back-guard machinery — visibly "a different
 * kind of window" next to the ship-detail modal and the settings one. It
 * is now the SAME window recipe as ShipDetailModal: HkModal owns the
 * chrome (title, close, enter/leave animation, animationBus motion
 * reporting, history-back guard, phone sheet docking) and this component
 * owns only the report-specific head actions.
 *
 * The long-image export button rides HkModal's `headerActions` slot; the
 * capture itself stays in StaticReportPanel (its exposed `exportPng`
 * targets the panel's export root), so the modal is the only owner of the
 * exporting flag and the host no longer drills it through.
 *
 * Props are the host's data layer, kept in ReplayView (parser-coupled
 * fetch, stale-response seq guard, out-of-band replay swap watch): open
 * flag, the report (or null while the first fetch runs), the loading and
 * error flags. Events mirror the panel's: `close` (HkModal dismissed),
 * `seek` (moment jump → the host drives the battle map), `pick`
 * (perspective switch → the host refetches).
 *
 * The report sheet itself stays dark inside the themed chrome on purpose —
 * it is a share/export artifact (导出长图 captures the dark sheet); the
 * window CHROME is what this component unifies, not the sheet's palette.
 */
export default defineComponent({
  name: "StaticReportModal",
  props: {
    open: { type: Boolean, default: false },
    report: { type: Object as PropType<StaticReport | null>, default: null },
    loading: { type: Boolean, default: false },
    error: { type: String as PropType<string | null>, default: null },
  },
  emits: {
    close: () => true,
    seek: (_t0: number) => true,
    pick: (_entityId: number) => true,
  },
  setup(props, { emit }) {
    /** The chromeless panel's capture handle — the header export button's
     *  only job is to drive it (and own the busy flag). */
    const panelRef = ref<{ exportPng: () => Promise<void> } | null>(null);
    const exporting = ref(false);
    const onExport = async () => {
      if (exporting.value || !panelRef.value) return;
      exporting.value = true;
      try {
        await panelRef.value.exportPng();
      } finally {
        exporting.value = false;
      }
    };

    return () => (
      <HkModal
        modelValue={props.open}
        onUpdate:modelValue={(v: boolean) => {
          if (!v) emit("close");
        }}
        title={t("replay.report.title")}
        width="min(1040px, 94vw)"
        contentClass="wowsp-report-modal"
      >
        {{
          headerLead: props.loading
            ? () => <HkSpinner size="xs" tone="current" />
            : undefined,
          headerActions:
            props.report && !props.error
              ? () => (
                  <HkButton
                    variant="secondary"
                    size="sm"
                    loading={exporting.value}
                    onClick={() => void onExport()}
                  >
                    {exporting.value ? null : <Download size={13} />}
                    <span>
                      {t(
                        exporting.value
                          ? "replay.report.exporting"
                          : "replay.report.export",
                      )}
                    </span>
                  </HkButton>
                )
              : undefined,
          default: () => {
            if (props.error) {
              return (
                <div class="wowsp-report-modal__body">
                  <ErrorCard
                    title={t("replay.report.title")}
                    error={props.error ?? ""}
                  />
                </div>
              );
            }
            if (props.report) {
              return (
                <StaticReportPanel
                  ref={panelRef}
                  report={props.report}
                  loading={props.loading}
                  onSeek={(t0: number) => emit("seek", t0)}
                  onPick={(entityId: number) => emit("pick", entityId)}
                />
              );
            }
            return (
              <div class="wowsp-report-modal__body wowsp-report-modal__loading">
                <HkSpinner size="md" tone="current" />
                <span>{t("replay.report.loading")}</span>
              </div>
            );
          },
        }}
      </HkModal>
    );
  },
});
