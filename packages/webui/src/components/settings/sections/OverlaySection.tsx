/** Overlay settings card: view mode, roster attribution and the
 *  display-content controls. Rendered as the leading card of the
 *  calibration section's page (the anchor calibrations follow below). */
import { defineComponent, type PropType } from "vue";
import { ExternalLink } from "@lucide/vue";
import { HkButton, HkSettingsGroup, HkSettingsHint, HkSettingsSub, HkTabs } from "@celestia-island/hikari";
import { useRouter } from "vue-router";

import { t } from "@/i18n";
import {
  useOverlayConfigStore,
  type RosterRecognitionMode,
  type TableAnchorMode,
} from "@/stores/overlayConfig";
import { useSettingsUiStore } from "@/stores/settingsUi";
import OverlayContentControls from "@/components/settings/OverlayContentControls";
import { INGAME_PLUGIN_MOD_ID } from "@/components/settings/useSettingsGamePaths";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
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
    return () => (
          <>
          {/* The in-game water meter — the view mode picks whether the
              transparent window over the pixel-detected team table is up
              while the game runs (hold Tab for per-player WR / avg
              damage) or the whole Tab overlay is off. The second switch
              (roster attribution) picks the plugin telemetry (the
              default) or the screen-capture pipeline, and its strip
              auto-disables while the view mode is off; the plugin's
              Discussions page rides the same row's right edge.
              Unreachable on the phone app build (no overlay window there —
              the rail filters the section out). */}
          <HkSettingsGroup title={t("settings.overlay")}>
            <HkSettingsHint>{t("settings.overlayDesc")}</HkSettingsHint>
            <HkSettingsSub title={t("settings.overlayTable")}>
              <HkTabs
                block
                variant="segmented"
                modelValue={overlayCfg.table}
                onUpdate:modelValue={(v: string) => void overlayCfg.setTable(v as TableAnchorMode)}
                tabs={[
                  { key: "detect", label: t("settings.overlayTableDetect") },
                  { key: "off", label: t("settings.overlayTableOff") },
                ]}
              />
              {/* Fullscreen limits the overlay-window mode only — with the
                  switch off there is nothing to display in the first
                  place. */}
              {overlayCfg.table === "detect" ? (
                <HkSettingsHint>{t("settings.overlayFullscreenNote")}</HkSettingsHint>
              ) : null}
            </HkSettingsSub>
            <HkSettingsSub title={t("settings.overlayRoster")}>
              {/* No "off" here BY DESIGN: the table switch above owns the
                  whole overlay's off state, and with it on, one of the two
                  detectors is always in force. The whole strip auto-
                  disables while the table switch is off. */}
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
