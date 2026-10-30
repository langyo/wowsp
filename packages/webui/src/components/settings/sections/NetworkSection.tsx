/** Network settings section: proxy mode + URL, the resource CDN, and the
 *  connectivity diagnostics panel (网络诊断). */
import { defineComponent, type PropType } from "vue";
import { HkButton, HkInput, HkSettingsGroup, HkSettingsHint, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { NetworkConfig } from "@/api";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

/** Display label for the shell's documented probe endpoints. */
function endpointLabel(endpoint: string): string {
  switch (endpoint) {
    case "github":
      return t("settings.networkDiagEndpointGithub");
    case "wg-api":
      return t("settings.networkDiagEndpointWg");
    default:
      return endpoint;
  }
}

/** Display label for which stack a probe row rode. */
function pathLabel(path: string): string {
  return path === "proxy" ? t("settings.networkDiagPathProxy") : t("settings.networkDiagPathDirect");
}

/** Provenance label for `effectiveProxy` ("manual" | "env" | "registry"). */
function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "manual":
      return t("settings.networkDiagSourceManual");
    case "env":
      return t("settings.networkDiagSourceEnv");
    case "registry":
      return t("settings.networkDiagSourceRegistry");
    default:
      return "";
  }
}

export default defineComponent({
  name: "SettingsNetworkSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { network } = props.ctx;
    return () => {
      const report = network.probe.value;
      // After a probe the report is the truth even when it says "no proxy"
      // (null must not fall back to the config snapshot — that is the stale
      // value a probe exists to correct).
      const effective = (report ? report.effectiveProxy : network.netCfg.value.effectiveProxy) ?? null;
      const source = report?.proxySource ?? null;
      return (
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
                mode; the same input+Save row grammar as the proxy URL keeps
                both URL fields at one width with a visible commit button. */}
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  modelValue={network.netCfg.value.resourceCdn ?? ""}
                  onUpdate:modelValue={(v: string) => (network.netCfg.value.resourceCdn = v)}
                  placeholder={t("settings.resourceCdnPlaceholder")}
                  submitOnEnter={() => void network.saveNet()}
                />
              </div>
              <HkButton size="sm" disabled={!network.netDirty.value} onClick={() => void network.saveNet()}>
                {network.netSavedFlash.value ? t("settings.networkSaved") : t("settings.networkSave")}
              </HkButton>
            </div>
            <HkSettingsHint>{t("settings.resourceCdnHint")}</HkSettingsHint>
          </HkSettingsGroup>

          {/* 网络诊断 — one-shot probe matrix + the two WinINET channels the
              built-in downloader cannot follow (PAC/WPAD), disclosed instead
              of failing silently. */}
          <HkSettingsGroup title={t("settings.networkDiag")}>
            <HkSettingsHint>{t("settings.networkDiagHint")}</HkSettingsHint>
            <div class="settings-modal__netdiag">
              <div class="settings-modal__netdiagrow">
                <span class="settings-modal__netdiaglabel">{t("settings.networkDiagEffective")}</span>
                <span class="settings-modal__netdiagvalue">
                  {effective
                    ? `${effective}${source ? ` (${sourceLabel(source)})` : ""}`
                    : t("settings.networkDiagDirect")}
                </span>
              </div>
              {report?.system.pacConfigured ? (
                <div class="settings-modal__netdiagwarn">{t("settings.networkDiagPac")}</div>
              ) : null}
              {report?.system.autoDetect ? (
                <div class="settings-modal__netdiagwarn">{t("settings.networkDiagAutoDetect")}</div>
              ) : null}
              {network.probeError.value ? (
                <div class="settings-modal__netdiagerr">
                  {t("settings.networkDiagFailed", { error: network.probeError.value })}
                </div>
              ) : null}
              {report
                ? report.rows.map((row) => (
                    <div key={`${row.endpoint}-${row.path}`} class="settings-modal__netdiagrow">
                      <span class="settings-modal__netdiaglabel">{pathLabel(row.path)}</span>
                      <span class="settings-modal__netdiagvalue">{endpointLabel(row.endpoint)}</span>
                      {row.ok ? (
                        <span class="settings-modal__netdiagok">
                          {row.status != null ? `HTTP ${row.status} · ` : ""}
                          {`${row.elapsedMs} ms`}
                        </span>
                      ) : (
                        <span class="settings-modal__netdiagerr">{row.error ?? ""}</span>
                      )}
                    </div>
                  ))
                : null}
              {report && report.directPreferredHosts.length > 0 ? (
                <div class="settings-modal__netdiagwarn">
                  {t("settings.networkDiagDirectPreferred", { hosts: report.directPreferredHosts.join(", ") })}
                </div>
              ) : null}
            </div>
            <div class="settings-modal__netmanual">
              <HkButton size="sm" disabled={network.probing.value} onClick={() => void network.runProbe()}>
                {network.probing.value ? t("settings.networkDiagRunning") : t("settings.networkDiagRun")}
              </HkButton>
            </div>
          </HkSettingsGroup>
        </>
      );
    };
  },
});
