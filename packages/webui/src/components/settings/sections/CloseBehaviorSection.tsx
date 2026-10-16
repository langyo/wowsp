/** Close-behavior settings section: the remembered close action plus the
 *  in-game plugin install ask and its manual re-check. */
import { defineComponent, type PropType } from "vue";
import { HkButton, HkRadio, HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useCloseBehaviorStore, type CloseAction } from "@/stores/closeBehavior";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

export default defineComponent({
  name: "SettingsCloseBehaviorSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const closeBehavior = useCloseBehaviorStore();
    const { gamePaths } = props.ctx;
    return () => (
          <>
          {/* closeBehavior — the only place to read, change or clear what the
              close dialog's "remember my choice" checkbox wrote: without it
              a remembered choice is a one-way trip (the dialog never asks
              again). Same store the dialog uses, so the two cannot disagree;
              the minimize/quit labels reuse the dialog's tray.* strings so
              the wording cannot drift apart either. */}
          <HkSettingsGroup title={t("settings.closeBehavior")}>
            <HkRadio
              direction="vertical"
              modelValue={closeBehavior.action}
              onUpdate:modelValue={(v: string | number) =>
                closeBehavior.setAction(v as CloseAction)
              }
              options={[
                { value: "ask", label: t("settings.closeAsk") },
                { value: "minimize", label: t("tray.minimize") },
                { value: "quit", label: t("tray.quit") },
              ]}
            />
            <HkSettingsHint>{t("settings.closeBehaviorHint")}</HkSettingsHint>
            <HkSettingsHint>{t("settings.closeRememberHint")}</HkSettingsHint>
          </HkSettingsGroup>

          {/* In-game plugin install ask — shares the closeBehavior page (a
              "default app behavior" sibling of the close action): status of
              the boot-time ask, and the manual re-check that re-opens the
              install prompt regardless of the 不再提示 marker. */}
          <HkSettingsGroup title={t("settings.pluginPromptGroup")}>
            <HkSettingsHint>
              {gamePaths.activePath.value
                ? gamePaths.ingamePluginInstalled.value
                  ? t("settings.pluginPromptStateInstalled")
                  : t("settings.pluginPromptStateAbsent")
                : t("settings.pluginPromptStateNoGame")}
            </HkSettingsHint>
            <HkSettingsHint>{t("settings.pluginPromptHint")}</HkSettingsHint>
            <div>
              <HkButton
                size="sm"
                variant="secondary"
                onClick={() => void gamePaths.recheckIngamePlugin()}
              >
                {t("settings.pluginPromptRecheck")}
              </HkButton>
            </div>
          </HkSettingsGroup>

          </>
    );
  },
});
