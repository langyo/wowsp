/** Network settings section: proxy mode + URL and the resource CDN. */
import { defineComponent, type PropType } from "vue";
import { HkButton, HkInput, HkSettingsGroup, HkSettingsHint, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { NetworkConfig } from "@/api";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

export default defineComponent({
  name: "SettingsNetworkSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { network } = props.ctx;
    return () => (
          <>
          {/* network proxy — applies to every outbound request (stats, model
              pack, updates); resource CDN mirrors remote resources
              independently of the proxy mode */}
          <HkSettingsGroup title={t("settings.network")}>
            <HkSettingsHint>{t("settings.networkHint")}</HkSettingsHint>
            <HkTabs
              block
              variant="segmented"
              modelValue={network.netCfg.value.mode}
              onUpdate:modelValue={(v: string) => void network.selectNetMode(v as NetworkConfig["mode"])}
              tabs={[
                { key: "system", label: t("settings.networkSystem") },
                { key: "none", label: t("settings.networkNone") },
                { key: "manual", label: t("settings.networkManual") },
              ]}
            />
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  modelValue={network.netCfg.value.proxy ?? ""}
                  onUpdate:modelValue={(v: string) => (network.netCfg.value.proxy = v)}
                  placeholder={t("settings.networkProxyPlaceholder")}
                  disabled={network.netCfg.value.mode !== "manual"}
                  submitOnEnter={() => void network.saveNet()}
                />
              </div>
              <HkButton size="sm" disabled={!network.netDirty.value} onClick={() => void network.saveNet()}>
                {network.netSavedFlash.value ? t("settings.networkSaved") : t("settings.networkSave")}
              </HkButton>
            </div>
            {/* Resource CDN — an independent setting, not gated on the proxy
                mode; commits via 保存 / Enter like the proxy URL. */}
            <div class="settings-modal__netinput">
              <HkInput
                modelValue={network.netCfg.value.resourceCdn ?? ""}
                onUpdate:modelValue={(v: string) => (network.netCfg.value.resourceCdn = v)}
                placeholder={t("settings.resourceCdnPlaceholder")}
                submitOnEnter={() => void network.saveNet()}
              />
            </div>
            <HkSettingsHint>{t("settings.resourceCdnHint")}</HkSettingsHint>
          </HkSettingsGroup>

          </>
    );
  },
});
