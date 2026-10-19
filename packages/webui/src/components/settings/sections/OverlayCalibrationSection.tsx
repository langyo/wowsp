/** Overlay calibration settings section (游戏内显示校准): the in-game
 *  water meter's card leads (view mode / roster attribution / display
 *  content — see OverlaySection), then the persistent per-client
 *  Tab-anchor calibrations the overlay detector stores. One card
 *  per client install — client key, kind badge, last-updated stamp — with
 *  its independent PvP / PvE entries (table rect, row count, team split,
 *  window identity, state badges). Each entry's edit button reopens the
 *  shared manual-locate picker in calibration mode (see ManualLocateOverlay)
 *  against any reference image; the submitted box rescales onto the STORED
 *  entry, so editing never depends on the client currently running. */
import { defineComponent, onMounted, ref, type PropType } from "vue";
import { RefreshCw, SquarePen } from "@lucide/vue";
import {
  HkButton,
  HkSettingsGroup,
  HkSettingsHint,
  HkSpinner,
  HkTag,
  useToast,
} from "@celestia-island/hikari";

import { api, type CalibrationClientInfo, type CalibrationEntryInfo } from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useManualLocateStore } from "@/stores/manualLocate";
import OverlaySection from "@/components/settings/sections/OverlaySection";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import "./OverlayCalibrationSection.scss";

/** Rust's `kind_name` spells kongzhong without the cn- prefix the i18n
 *  table's key uses; every other kind string matches `common.game.kind.*`
 *  directly. Unknown kinds fall back to the raw string. */
const KIND_KEY_FIX: Record<string, string> = { kongzhong: "cnKongzhong" };

function kindLabelOf(kind: string): string {
  const key = `common.game.kind.${KIND_KEY_FIX[kind] ?? kind}`;
  const lbl = t(key);
  return lbl === key ? kind : lbl;
}

/** Locale-aware relative time (Intl.RelativeTimeFormat — no hand-rolled
 *  unit words per locale), coarse-grained to the most fitting unit. */
function relativeTime(at: number, locale: string): string {
  const diff = at - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

export default defineComponent({
  name: "SettingsOverlayCalibrationSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const manualLocate = useManualLocateStore();
    const { uiLocale } = useLanguage();
    const toast = useToast();
    const clients = ref<CalibrationClientInfo[]>([]);
    const loading = ref(false);

    async function refresh() {
      loading.value = true;
      try {
        clients.value = await api.fetchOverlayCalibrationList();
      } catch (err) {
        toast.error(`${t("settings.overlayCalibration")}: ${(err as Error).message || err}`);
      } finally {
        loading.value = false;
      }
    }
    onMounted(() => void refresh());

    /** One entry's edit button: arm the backend's picker-open flag (no
     *  battle gates here), then raise the shared picker layer in
     *  calibration mode with this client + class as the submit target. */
    async function editEntry(c: CalibrationClientInfo, cls: "pvp" | "pve") {
      try {
        await api.startCalibrationLocate();
      } catch (err) {
        toast.error(`${t("settings.overlayCalibration")}: ${(err as Error).message || err}`);
        return;
      }
      manualLocate.openPicker({
        mode: "calibration",
        calibration: { clientKey: c.clientKey, class: cls },
      });
    }

    /** One battle-class row of a client card. */
    function classRow(c: CalibrationClientInfo, cls: "pvp" | "pve") {
      const e: CalibrationEntryInfo | null = cls === "pvp" ? c.pvp : c.pve;
      return (
        <div class="calib-sec__class" key={cls}>
          <span class="calib-sec__class-label">
            {t(
              cls === "pvp"
                ? "settings.overlayCalibrationClassPvp"
                : "settings.overlayCalibrationClassPve",
            )}
          </span>
          {e ? (
            <>
              <span class="calib-sec__badges">
                {e.certified ? (
                  <HkTag variant="success" size="sm">
                    {t("settings.overlayCalibrationCertified")}
                  </HkTag>
                ) : null}
                {e.manual ? (
                  <HkTag variant="info" size="sm">
                    {t("settings.overlayCalibrationManual")}
                  </HkTag>
                ) : null}
                {e.suspect ? (
                  <HkTag variant="warning" size="sm">
                    {t("settings.overlayCalibrationSuspect")}
                  </HkTag>
                ) : null}
              </span>
              {/* The stored table rectangle, game-window relative
                  (physical px) — the "key feature points" the detector
                  anchored. */}
              <span class="calib-sec__num" title={e.screen}>
                {e.rosterRect.x},{e.rosterRect.y} · {e.rosterRect.width}×{e.rosterRect.height}
              </span>
              <span class="calib-sec__meta">{t("replay.live.detectedRows", { n: e.rowCenters.length })}</span>
              <span class="calib-sec__num">
                {e.teamSizes[0]}v{e.teamSizes[1]}
              </span>
              {/* Window identity the entry was measured at — editing keeps
                  it, so mismatches here explain a remap rather than block
                  one. */}
              <span class="calib-sec__num">
                @{e.gameOrigin[0]},{e.gameOrigin[1]} · {e.gameSize[0]}×{e.gameSize[1]}
              </span>
              <HkButton
                size="sm"
                variant="secondary"
                onClick={() => void editEntry(c, cls)}
              >
                <SquarePen size={13} />
                {t("settings.overlayCalibrationEdit")}
              </HkButton>
            </>
          ) : (
            <span class="calib-sec__missing">—</span>
          )}
        </div>
      );
    }

    return () => (
          <>
          {/* The water meter's own card first (view mode, roster
              attribution, display content) — the calibration list below
              only matters once the overlay is on. */}
          <OverlaySection ctx={props.ctx} />
          {/* in-game overlay anchor calibration — the detector's persistent
              per-client memory of where the Tab table sat. The list is a
              pure read (overlay_calibration_list); the edit flow reopens
              the shared picker in calibration mode. Unreachable on the
              phone app build (no overlay window there — the rail filters
              the section out). */}
          <HkSettingsGroup title={t("settings.overlayCalibration")}>
            <HkSettingsHint>{t("settings.overlayCalibrationDesc")}</HkSettingsHint>
            <div class="calib-sec__toolbar">
              <HkButton size="sm" variant="secondary" loading={loading.value} onClick={() => void refresh()}>
                <RefreshCw size={13} />
                {t("settings.overlayCalibrationRefresh")}
              </HkButton>
            </div>
            {loading.value && clients.value.length === 0 ? (
              <div class="calib-sec__state">
                <HkSpinner size={16} tone="current" />
              </div>
            ) : clients.value.length === 0 ? (
              <HkSettingsHint>{t("settings.overlayCalibrationEmpty")}</HkSettingsHint>
            ) : (
              <div class="calib-sec__clients">
                {clients.value.map((c) => (
                  <div class="calib-sec__client" key={c.clientKey}>
                    <div class="calib-sec__head">
                      <span class="calib-sec__key" title={c.clientKey}>{c.clientKey}</span>
                      <HkTag variant="default" size="sm">{kindLabelOf(c.kind)}</HkTag>
                      {c.updatedAtMs != null ? (
                        <span class="calib-sec__updated">
                          {t("settings.overlayCalibrationUpdated", {
                            time: relativeTime(c.updatedAtMs, uiLocale.value),
                          })}
                        </span>
                      ) : null}
                    </div>
                    {classRow(c, "pvp")}
                    {classRow(c, "pve")}
                  </div>
                ))}
              </div>
            )}
          </HkSettingsGroup>

          </>
    );
  },
});
