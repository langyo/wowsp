/** Network settings section: proxy mode + URL, the resource CDN, and the
 *  connectivity diagnostics panel (网络诊断). */
import { defineComponent, onMounted, type PropType, type VNode } from "vue";
import {
  HkButton,
  HkInput,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkStatusPill,
  HkTable,
  HkTabs,
  HkTag,
  HkTooltip,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { NetworkConfig, NetworkProbeRow, UpstreamHostReport } from "@/api";
import { useUpstreamHealthStore } from "@/stores/upstreamHealth";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

/** Whether a proxy URL embeds credentials (a userinfo part before the
 *  host) — the app's own stack dials them, the WebView2 mirror cannot. */
function proxyUrlHasCredentials(url: string): boolean {
  const afterScheme = url.split("://", 2)[1] ?? url;
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? afterScheme;
  return authority.includes("@");
}

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

/** Provenance label for `effectiveProxy`
 *  ("manual" | "env" | "registry" | "pac"). */
function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "manual":
      return t("settings.networkDiagSourceManual");
    case "env":
      return t("settings.networkDiagSourceEnv");
    case "registry":
      return t("settings.networkDiagSourceRegistry");
    case "pac":
      return t("settings.networkDiagSourcePac");
    default:
      return "";
  }
}

/** Probe-matrix rows for HkTable: path/endpoint labels resolved once, a
 *  stable per-row key, and the original report row carried along for the
 *  verdict slot cell. Pure — the render and the tests share it. */
function probeTableRows(rows: NetworkProbeRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    id: `${row.endpoint}-${row.path}`,
    path: pathLabel(row.path),
    endpoint: endpointLabel(row.endpoint),
    probe: row,
  }));
}

/** Health-table rows: the purpose i18n resolved once, a stable key, and
 *  the store entry carried along for the latency slot cell. Pure. */
function healthTableRows(entries: UpstreamHostReport[]): Record<string, unknown>[] {
  return entries.map((e) => ({
    id: e.id,
    purpose: t("upstream.purpose." + e.purpose),
    host: e.host,
    entry: e,
  }));
}

/** The health verdict pill: failing streak first, then the last success's
 *  wall time, else the grey "no data yet" state. Pure. */
function healthPill(entry: UpstreamHostReport): VNode {
  if (entry.consecutiveFailures > 0) {
    return (
      <HkStatusPill
        state="error"
        label={t("settings.networkDiagHealthFails", { n: entry.consecutiveFailures })}
      />
    );
  }
  if (entry.lastElapsedMs != null) {
    return <HkStatusPill state="ok" latencyMs={entry.lastElapsedMs} />;
  }
  return <HkStatusPill state="unknown" />;
}

/** The probe verdict pill: ok rows carry the HTTP status + latency; an
 *  error row's reqwest message ellipsizes to one line (the pill's own
 *  label styling) with the full text on a tooltip, so a long failure
 *  never blows up the row. Pure. */
function probePill(row: NetworkProbeRow): VNode {
  if (row.ok) {
    return (
      <HkStatusPill
        state="ok"
        label={row.status != null ? `HTTP ${row.status}` : ""}
        latencyMs={row.elapsedMs}
      />
    );
  }
  return (
    <HkTooltip text={row.error ?? ""}>
      <HkStatusPill state="error" label={row.error ?? ""} />
    </HkTooltip>
  );
}

export default defineComponent({
  name: "SettingsNetworkSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { network } = props.ctx;
    // The diagnostics panel doubles as a reader for the upstream health
    // table (the same data the title-bar fault chip rides): recent
    // per-host latency turns a slow proxy into visible numbers.
    const health = useUpstreamHealthStore();
    onMounted(() => void health.refresh());
    return () => {
      const report = network.probe.value;
      // After a probe the report is the truth even when it says "no proxy"
      // (null must not fall back to the config snapshot — that is the stale
      // value a probe exists to correct).
      const effective = (report ? report.effectiveProxy : network.netCfg.value.effectiveProxy) ?? null;
      // The config snapshot carries the channel provenance too — before
      // the first probe it is the only signal the pane has (after a probe
      // the report is the truth, and a null source there must NOT fall
      // back to the snapshot).
      const source = report ? (report.proxySource ?? null) : (network.netCfg.value.proxySource ?? null);
      const sys = report?.system;
      const pacConfigured = sys?.pacConfigured ?? false;
      // PAC is a fact of the machine's config, not a fault: the row's tag
      // marks the configuration (from the report's WinINET read, or —
      // before any probe — from the snapshot's provenance), and this
      // muted hint states what the downloader does with it — per-host
      // resolution while the script loads and parses, the manual-proxy/
      // direct fallback when it does not. Configured but unprobed reads
      // as active, never as a warning.
      const pacKnown = pacConfigured || source === "pac";
      const pacHint = !pacKnown
        ? null
        : sys?.pacStatus === "unavailable"
          ? t("settings.networkDiagPacUnavailable")
          : t("settings.networkDiagPacActive");
      const recordedHosts = health.entries.filter((e) => e.recorded);
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
            {network.netCfg.value.mode === "manual" ? (
              <HkSettingsHint>{t("settings.networkManualRestartHint")}</HkSettingsHint>
            ) : null}
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
              built-in downloader treats differently (PAC is resolved per
              host; WPAD is disclosed instead of followed). The group's own
              flex gap owns the rhythm; the two matrices are hikari HkTables
              with fixed left-aligned columns. */}
          <HkSettingsGroup title={t("settings.networkDiag")}>
            <HkSettingsHint>{t("settings.networkDiagHint")}</HkSettingsHint>
            <div class="settings-modal__netdiag-effective">
              <span class="settings-modal__netdiaglabel">{t("settings.networkDiagEffective")}</span>
              <span class="settings-modal__netdiagvalue">
                <span class="settings-modal__netdiagvaluetext">
                  {source === "pac"
                    ? t("settings.networkDiagPacPerHost")
                    : effective
                      ? `${effective}${source ? ` (${sourceLabel(source)})` : ""}`
                      : t("settings.networkDiagDirect")}
                </span>
                {pacKnown ? (
                  <HkTag variant="info" size="sm">{t("settings.networkDiagPacTag")}</HkTag>
                ) : null}
              </span>
            </div>
            {pacHint ? <HkSettingsHint>{pacHint}</HkSettingsHint> : null}
            {effective && proxyUrlHasCredentials(effective) ? (
              <div class="settings-modal__netdiagwarn">
                {t("settings.networkDiagCredentialHint")}
              </div>
            ) : null}
            {sys?.autoDetect ? (
              <div class="settings-modal__netdiagwarn">{t("settings.networkDiagAutoDetect")}</div>
            ) : null}
            {network.probeError.value ? (
              <div class="settings-modal__netdiagerr">
                {t("settings.networkDiagFailed", { error: network.probeError.value })}
              </div>
            ) : null}
            {report && report.rows.length > 0 ? (
              <HkTable
                size="sm"
                columns={[
                  { key: "path", title: t("settings.networkDiagColPath"), width: "5rem", align: "left" },
                  { key: "endpoint", title: t("settings.networkDiagColEndpoint"), width: "7rem", align: "left" },
                  { key: "result", title: t("settings.networkDiagColResult"), width: "12rem", align: "left" },
                ]}
                rows={probeTableRows(report.rows)}
                rowKey="id"
                v-slots={{
                  "cell-result": ({ row }: { row: Record<string, unknown> }) =>
                    probePill(row.probe as NetworkProbeRow),
                }}
              />
            ) : null}
            {report && report.directPreferredHosts.length > 0 ? (
              <div class="settings-modal__netdiagwarn">
                {t("settings.networkDiagDirectPreferred", { hosts: report.directPreferredHosts.join(", ") })}
              </div>
            ) : null}
            {recordedHosts.length > 0 ? (
              <HkSettingsSub title={t("settings.networkDiagHealthTitle")}>
                <HkTable
                  size="sm"
                  columns={[
                    { key: "purpose", title: t("settings.networkDiagColPurpose"), width: "9.5rem", align: "left" },
                    { key: "host", title: t("settings.networkDiagColHost"), width: "13rem", align: "left" },
                    { key: "latency", title: t("settings.networkDiagColLatency"), width: "9rem", align: "left" },
                  ]}
                  rows={healthTableRows(recordedHosts)}
                  rowKey="id"
                  v-slots={{
                    "cell-latency": ({ row }: { row: Record<string, unknown> }) =>
                      healthPill(row.entry as UpstreamHostReport),
                  }}
                />
              </HkSettingsSub>
            ) : null}
            <div class="settings-modal__netmanual">
              <HkButton
                size="sm"
                disabled={network.probing.value}
                onClick={() => {
                  void network.runProbe();
                  void health.refresh();
                }}
              >
                {network.probing.value ? t("settings.networkDiagRunning") : t("settings.networkDiagRun")}
              </HkButton>
            </div>
          </HkSettingsGroup>
        </>
      );
    };
  },
});
