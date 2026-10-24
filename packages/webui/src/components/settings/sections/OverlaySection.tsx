/** Overlay settings card: the per-window display switches, roster
 *  attribution and the display-content controls. Rendered as the leading
 *  card of the calibration section's page (the anchor calibrations follow
 *  below). */
import {
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type PropType,
} from "vue";
import { ExternalLink, TriangleAlert } from "@lucide/vue";
import {
  HkButton,
  HkInput,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSlider,
  HkSwitch,
  HkTabs,
} from "@celestia-island/hikari";
import { useRouter } from "vue-router";

import { t } from "@/i18n";
import { api } from "@/api";
import type { OverlayDiag } from "@/api";
import {
  AIM_CARD_HANG_SLIDER_MAX,
  AIM_CARD_HANG_SLIDER_MIN,
  useOverlayConfigStore,
  type RosterRecognitionMode,
  type TableAnchorMode,
} from "@/stores/overlayConfig";
import { useSettingsUiStore } from "@/stores/settingsUi";
import OverlayContentControls from "@/components/settings/OverlayContentControls";
import { INGAME_PLUGIN_MOD_ID } from "@/components/settings/useSettingsGamePaths";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
// Same row pattern as the content controls below (label + description
// left, switch right).
import "../../stats/StatsPrefsControls.scss";
import "./OverlaySection.scss";

export default defineComponent({
  name: "SettingsOverlaySection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const overlayCfg = useOverlayConfigStore();
    const ui = useSettingsUiStore();
    const router = useRouter();
    const { gamePaths } = props.ctx;

    // ── presentation diagnostics (the watcher's self-verify verdict) ────
    // The Tab overlay window is shown + marker-verified end-to-end by the
    // watcher; a FAILED verdict (window shown, content repeatedly absent
    // from a layered-inclusive screen capture) renders the red card below
    // with the risk flags read at verdict time. The events are
    // transition-only and this section usually mounts AFTER the verdict
    // (straight from the red pill's deep link), so mount subscribes FIRST
    // and then catch-up PULLS the standing state — the pull is skipped
    // when a push already landed, so it can never clobber a fresher event.
    const overlayDiag = ref<OverlayDiag | null>(null);
    let unlistenDiag: (() => void) | null = null;
    let diagDisposed = false;
    let diagPushed = false;
    onMounted(async () => {
      const unlisten = (await api.listenOverlayDiag((d) => {
        diagPushed = true;
        overlayDiag.value = d;
      })) as (() => void) | null;
      // Unmount raced the await: dispose immediately instead of leaking.
      if (diagDisposed) {
        unlisten?.();
      } else {
        unlistenDiag = unlisten;
      }
      const pulled = await api.getOverlayDiag().catch(() => null);
      if (!diagPushed) {
        overlayDiag.value = pulled ?? null;
      }
    });
    onBeforeUnmount(() => {
      diagDisposed = true;
      unlistenDiag?.();
      unlistenDiag = null;
    });

    // ── aim-card hang (logical px below the crosshair) ───────────────────
    // The slider commits live on every notch — the watcher re-reads the
    // config on its next tick and re-places the card, so the card tracks
    // the thumb. The edit box stages a DRAFT that commits on Enter / blur
    // (the network rows' grammar) and is deliberately NOT bounded by the
    // slider's 60–240 band: any value ≥ 0 goes (the store clamps negatives
    // to 0, the shell sanity-clamps at 100 000, and the placement pins
    // oversized hangs to the game window's bottom edge).
    const hangDraft = ref(String(overlayCfg.aimCardHangPx));
    watch(
      () => overlayCfg.aimCardHangPx,
      (v) => {
        hangDraft.value = String(v);
      },
    );

    function commitHangDraft() {
      const raw = hangDraft.value.trim();
      const parsed = Math.round(Number(raw));
      if (raw === "" || !Number.isFinite(parsed)) {
        // Empty / non-numeric — revert to what the store holds.
        hangDraft.value = String(overlayCfg.aimCardHangPx);
        return;
      }
      void overlayCfg.setAimCardHangPx(parsed);
    }

    return () => (
          <>
          {/* The in-game water meter — the window switches pick which of
              the two transparent windows are up while the game runs: the
              hold-Tab team table (per-player WR / avg damage) and the
              aimed-player stats card hanging below the crosshair. They are
              independent — the overlay mode stays up while either is on.
              The roster switch picks the plugin telemetry (the default) or
              the screen-capture pipeline, and its strip auto-disables
              while the table switch is off; the plugin's Discussions page
              rides the same row's right edge.
              Unreachable on the phone app build (no overlay window there —
              the rail filters the section out). */}
          <HkSettingsGroup title={t("settings.overlay")}>
            <HkSettingsHint>{t("settings.overlayDesc")}</HkSettingsHint>
            <HkSettingsSub title={t("settings.overlayShow")}>
              {/* The shared row container gives the switch rows the same
                  inter-row gap the content controls below use. The table
                  switch maps onto the schema's `table` enum ("detect" /
                  "off") — the same setting the old view-mode segment pair
                  wrote, so the persisted value and the watcher's
                  enforcement are unchanged. */}
              <div class="stats-prefs">
                <div class="stats-prefs__row">
                  <span class="stats-prefs__row-text">
                    <span class="stats-prefs__row-label">{t("settings.overlayTableToggle")}</span>
                    <span class="stats-prefs__row-desc">{t("settings.overlayTableToggleDesc")}</span>
                  </span>
                  <HkSwitch
                    modelValue={overlayCfg.table === "detect"}
                    onUpdate:modelValue={(v: boolean) =>
                      void overlayCfg.setTable((v ? "detect" : "off") as TableAnchorMode)
                    }
                  />
                </div>
                <div class="stats-prefs__row">
                  <span class="stats-prefs__row-text">
                    <span class="stats-prefs__row-label">{t("settings.overlayAimCardToggle")}</span>
                    <span class="stats-prefs__row-desc">{t("settings.overlayAimCardToggleDesc")}</span>
                  </span>
                  <HkSwitch
                    modelValue={overlayCfg.aimCard}
                    onUpdate:modelValue={(v: boolean) => void overlayCfg.setAimCard(v)}
                  />
                </div>
                {/* The card's hang below the crosshair — a dedicated row per
                    the switch above: slider (the 60–240 band) + a free-form
                    px box. Both persist and apply immediately (the watcher
                    re-places the card on its next tick); the Saved flash in
                    the title bar confirms each write. The whole row greys
                    out with the card's switch off. */}
                <div class="stats-prefs__row">
                  <span class="stats-prefs__row-text">
                    <span class="stats-prefs__row-label">{t("settings.overlayAimCardHang")}</span>
                    <span class="stats-prefs__row-desc">{t("settings.overlayAimCardHangDesc")}</span>
                  </span>
                  <div class="overlay-sec__hang-controls">
                    <HkSlider
                      class="overlay-sec__hang-slider"
                      min={AIM_CARD_HANG_SLIDER_MIN}
                      max={AIM_CARD_HANG_SLIDER_MAX}
                      step={1}
                      modelValue={overlayCfg.aimCardHangPx}
                      onUpdate:modelValue={(v: number) => void overlayCfg.setAimCardHangPx(v)}
                      disabled={!overlayCfg.aimCard}
                      ariaLabel={t("settings.overlayAimCardHang")}
                    />
                    {/* HkInput drops pass-through classes (inheritAttrs:
                        false, class stripped) — size it from the SCSS via
                        the wrapper's child selector instead. */}
                    <HkInput
                      modelValue={hangDraft.value}
                      onUpdate:modelValue={(v: string) => (hangDraft.value = v)}
                      type="number"
                      disabled={!overlayCfg.aimCard}
                      submitOnEnter={commitHangDraft}
                      onBlur={commitHangDraft}
                      aria-label={t("settings.overlayAimCardHang")}
                    />
                  </div>
                </div>
              </div>
              {/* Fullscreen limits the overlay windows only — with both
                  switches off there is nothing to display in the first
                  place. */}
              {overlayCfg.table === "detect" || overlayCfg.aimCard ? (
                <HkSettingsHint>{t("settings.overlayFullscreenNote")}</HkSettingsHint>
              ) : null}
            </HkSettingsSub>
            {/* Presentation diagnostics — rendered ONLY on a failed
                self-verify verdict; the lines list the risk flags the
                backend probed at verdict time (advisory context, not
                verdicts of their own). */}
            {overlayDiag.value?.presentation === "failed" ? (
              <HkSettingsSub title={t("settings.overlayDiagTitle")}>
                <HkSettingsHint>{t("settings.overlayDiagBody")}</HkSettingsHint>
                <ul class="overlay-sec__diag">
                  {overlayDiag.value.mpoDisabled ? (
                    <li>
                      <TriangleAlert size={13} />
                      {t("settings.overlayDiagMpo")}
                    </li>
                  ) : null}
                  {overlayDiag.value.transparencyEffectsOff ? (
                    <li>
                      <TriangleAlert size={13} />
                      {t("settings.overlayDiagTransparency")}
                    </li>
                  ) : null}
                  {overlayDiag.value.hagsOff ? (
                    <li>
                      <TriangleAlert size={13} />
                      {t("settings.overlayDiagHags")}
                    </li>
                  ) : null}
                  {overlayDiag.value.cloaked ? (
                    <li>
                      <TriangleAlert size={13} />
                      {t("settings.overlayDiagCloaked")}
                    </li>
                  ) : null}
                  <li>
                    {overlayDiag.value.webview2Version
                      ? t("settings.overlayDiagWebview2", {
                          v: overlayDiag.value.webview2Version,
                        })
                      : t("settings.overlayDiagWebview2Missing")}
                  </li>
                  {/* Detection-layer reason (overlay review H-2): the
                      machine-readable label of the last roster-detection
                      refusal with its age — shown only while a refusal is
                      on record (a null means every detection succeeds). */}
                  {overlayDiag.value.detectFailure ? (
                    <li>
                      <TriangleAlert size={13} />
                      {t("settings.overlayDiagDetectFailure", {
                        reason: overlayDiag.value.detectFailure,
                        age: overlayDiag.value.detectFailureAgeSec ?? 0,
                      })}
                    </li>
                  ) : null}
                </ul>
              </HkSettingsSub>
            ) : null}
            <HkSettingsSub title={t("settings.overlayRoster")}>
              {/* No "off" here BY DESIGN: the table switch above owns the
                  table window's off state, and with it on, one of the two
                  detectors is always in force. The whole strip auto-
                  disables while the table switch is off (roster attribution
                  feeds the table's detection pipeline only — the aim card
                  reads the plugin's telemetry without it). */}
              <div class="overlay-sec__roster-row">
                <HkTabs
                  block
                  variant="segmented"
                  modelValue={overlayCfg.roster}
                  onUpdate:modelValue={(v: string) =>
                    void overlayCfg.setRoster(v as RosterRecognitionMode)
                  }
                  tabs={[
                    {
                      key: "plugin",
                      label: t("settings.overlayRosterPlugin"),
                      // Greyed until the in-game plugin actually sits in the
                      // active install's res_mods — the status refreshes with
                      // the install selection (see refreshIngamePlugin).
                      disabled:
                        !gamePaths.ingamePluginInstalled.value || overlayCfg.table === "off",
                    },
                    {
                      key: "passive",
                      label: t("settings.overlayRosterPassive"),
                      disabled: overlayCfg.table === "off",
                    },
                  ]}
                />
                {gamePaths.ingamePluginDiscussion.value ? (
                  <HkButton
                    class="overlay-sec__plugin-page"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      // In-app jump, not a browser link: close the settings
                      // surface and deep-link the mod hub's catalog page to
                      // the plugin's row (ResourcesView handles ?mod=). The
                      // modal's hikari back guard rewinds its pushed history
                      // entry on close (a deferred macrotask) — a same-tick
                      // router.push races that rewind and gets stranded (see
                      // ShipDetailModal's identical workaround), so let the
                      // close settle first.
                      ui.hide();
                      setTimeout(() => void router.push({
                        path: "/resources",
                        query: { mod: INGAME_PLUGIN_MOD_ID },
                      }), 350);
                    }}
                  >
                    <ExternalLink size={13} />
                    {t("settings.overlayRosterPluginPage")}
                  </HkButton>
                ) : null}
              </div>
              {overlayCfg.table === "off" ? (
                <HkSettingsHint>{t("settings.overlayRosterDisabledByTable")}</HkSettingsHint>
              ) : null}
              {!gamePaths.ingamePluginInstalled.value ? (
                <HkSettingsHint>{t("settings.overlayRosterPluginMissing")}</HkSettingsHint>
              ) : null}
            </HkSettingsSub>
            {/* Display content — what the water table renders everywhere:
                the per-row numbers on the Tab overlay's chips AND the
                roster panels' columns (any mix of winrate / PR / battles /
                avg damage), which battle-mode career feeds them, the
                career seal stamps, the team-intel items and the overlay's
                team averages. All of it lives in the statsPrefs blob, and
                every surface applies a flip immediately — the panels
                through the store's reactivity, the overlay through the
                store's broadcast (see overlay/main.ts's refreshPrefs). */}
            <HkSettingsSub title={t("settings.overlayContent.title")}>
              <HkSettingsHint>{t("settings.overlayContent.hint")}</HkSettingsHint>
              <OverlayContentControls />
            </HkSettingsSub>
          </HkSettingsGroup>

          </>
    );
  },
});
