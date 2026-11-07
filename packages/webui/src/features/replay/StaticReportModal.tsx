import { defineComponent, ref, type PropType } from "vue";
import { Camera } from "@lucide/vue";
import { HkButton, HkModal, HkSpinner } from "@celestia-island/hikari";

import type { StaticReport } from "@/api";
import ErrorCard from "@/components/base/ErrorCard";
import { t } from "@/i18n";
import { useShareImage } from "@/features/share/useShareImage";
import StaticReportPanel from "@/features/holographic/StaticReportPanel";
import type { ReportSheetView } from "@/features/holographic/reportSheet";
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
 * The long-image COPY action rides HkModal's `headerActions` slot: the
 * capture itself stays in StaticReportPanel (its exposed `capturePng`
 * renders the panel's export root to PNG bytes), while the clipboard write
 * and the success/failure toast ride the shared copy-shot kit
 * (features/share/useShareImage) — the SAME pipeline every 战绩图片 export
 * uses. It used to trigger an `<a download>` click instead: WebView2
 * dropped the file into the Downloads folder with no in-app feedback, so
 * the button read as dead (2026-11-06 report), and the toast contract was
 * missing either way.
 *
 * Props are the host's data layer, kept in ReplayView (parser-coupled
 * fetch, stale-response seq guard, out-of-band replay swap watch): open
 * flag, the report (or null while the first fetch runs), the loading and
 * error flags. Events mirror the panel's: `close` (HkModal dismissed),
 * `seek` (keyframe pick → the host closes this window, seeks the battle
 * map and locks the 3D camera to the analyzed player), `pick`
 * (perspective switch → the host refetches).
 *
 * The report sheet itself stays dark inside the themed chrome on purpose —
 * it is a share artifact (the copied long image captures the dark sheet),
 * and the CHROME is what this component unifies, not the sheet's palette.
 */
export default defineComponent({
  name: "StaticReportModal",
  props: {
    open: { type: Boolean, default: false },
    report: { type: Object as PropType<StaticReport | null>, default: null },
    loading: { type: Boolean, default: false },
    error: { type: String as PropType<string | null>, default: null },
    /** Host-resolved sheet faces (player identity, battle meta, roster ship
     *  icons) — passed straight through to the chromeless panel. */
    sheet: { type: Object as PropType<ReportSheetView | null>, default: null },
  },
  emits: {
    close: () => true,
    seek: (_t0: number) => true,
    pick: (_entityId: number) => true,
  },
  setup(props, { emit }) {
    /** The chromeless panel's capture handle — the header action's only job
     *  is to drive it. */
    const panelRef = ref<{ capturePng: () => Promise<Uint8Array> } | null>(null);
    /** Copy the report's long image onto the clipboard: render → clipboard
     *  → toast, all owned by the shared kit (native IPC first, webview
     *  clipboard fallback, one toast on either outcome). */
    const shot = useShareImage(
      async () => {
        const panel = panelRef.value;
        if (!panel) throw new Error("report panel is not mounted");
        return panel.capturePng();
      },
      {
        // The cached long image belongs to ONE report + perspective + sheet:
        // any of these changing means re-render before copying (a repeated
        // click on the same content re-copies instantly instead). The ship
        // faces are part of the identity head and land ASYNC (encyclopedia
        // realm list, stats batch): a copy made before they resolve must not
        // pin the image without the tier/ship line, so they ride the
        // signature too (2026-11-07 review).
        signature: () =>
          [
            props.report?.entityId ?? "",
            props.report?.durationS ?? "",
            props.report?.moments.length ?? "",
            props.report?.timeline.length ?? "",
            props.sheet?.identity.name ?? "",
            props.sheet?.identity.clanTag ?? "",
            props.sheet?.identity.dogTag ? 1 : 0,
            props.sheet?.identity.shipType ?? "",
            props.sheet?.identity.shipName ?? "",
            props.sheet?.identity.tier ?? "",
            props.sheet?.meta.battleStart ?? "",
            props.sheet?.meta.replayHash ?? "",
          ].join("|"),
      },
    );

    return () => (
      <HkModal
        modelValue={props.open}
        onUpdate:modelValue={(v: boolean) => {
          if (!v) emit("close");
        }}
        title={t("replay.report.title")}
        width="min(1180px, 94vw)"
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
                    loading={shot.busy.value}
                    onClick={() => void shot.copyShot()}
                  >
                    {shot.busy.value ? null : <Camera size={13} />}
                    <span>
                      {t(
                        shot.busy.value
                          ? "replay.report.copying"
                          : "replay.report.copy",
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
                  sheet={props.sheet}
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
