/** Pairing settings section — the gateway-push surface (route entry +
 *  mobile service + self-host wizard). The LEGACY LAN pairing is gone
 *  from the UI entirely. Phone build renders the PHONE (client) side:
 *  the route entry field (custom domain for self-host) plus the existing
 *  paired-computers management; the wizard stays desktop-only
 *  (publishing is a desktop concern).
 *
 *  Desktop primary UI (gateway-push §5): the ROUTE ENTRY (readonly
 *  official default / editable custom root, normalized by Rust —
 *  selecting 自定义 reveals the connect-existing editor and the deploy
 *  entry), the MOBILE SERVICE toggle (enabled → gateway_publish_start on
 *  the session-hub route; disabled → stop), the gateway status (phase
 *  from wowsp://gateway-state via the gateway store), and the self-host
 *  wizard entry. The relay pairing-code display is GONE from the UI. */
import { computed, defineComponent, type PropType } from "vue";
import { Rocket, Smartphone } from "@lucide/vue";
import {
  HkAlert,
  HkButton,
  HkInput,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSpinner,
  HkTabs,
  HkTag,
} from "@celestia-island/hikari";

import { t, tError } from "@/i18n";
import { GATEWAY_OFFICIAL_ROOT } from "@/api";
import SelfhostWizard from "@/components/settings/SelfhostWizard";
import { entryKey } from "@/stores/pairing";
import { isMobileApp } from "@/utils/platform";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import "./gatewaySettings.scss";

/** The publish status pill's voice (phase → tone + label). */
function phaseVoice(phase: string): { tone: string; label: string } {
  switch (phase) {
    case "resolving":
      return { tone: "pending", label: t("gateway.phaseResolving") };
    case "captcha":
      return { tone: "pending", label: t("gateway.phaseCaptcha") };
    case "connecting":
      return { tone: "pending", label: t("gateway.phaseConnecting") };
    case "online":
      return { tone: "online", label: t("gateway.phaseOnline") };
    case "error":
      return { tone: "error", label: t("gateway.phaseError") };
    default:
      return { tone: "idle", label: t("gateway.phaseStopped") };
  }
}

export default defineComponent({
  name: "SettingsPairingSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { pairing, gateway: gw } = props.ctx;
    const pairingStore = pairing.pairingStore;
    const gateway = gw.gateway;
    const shownPlayer = gw.shownPlayer;

    /** The route-entry block — shared by BOTH builds (desktop: the
     *  service's entry; phone: the custom-domain field for self-host). */
    const renderRoot = () => (
      <>
        <HkSettingsSub title={t("gateway.rootLabel")} />
        <HkTabs
          block
          variant="segmented"
          modelValue={gw.rootMode.value}
          onUpdate:modelValue={(v: string) => {
            // Selecting a tab never saves by itself: "official" restores
            // the official entry (the one free choice), "custom" only
            // reveals the editor + the deploy/connect actions below.
            gw.rootMode.value = v === "custom" ? "custom" : "official";
            if (v === "official" && !gw.usingOfficial.value) {
              void gw.useOfficialRoot();
            }
          }}
          tabs={[
            { key: "official", label: t("gateway.rootOfficial") },
            { key: "custom", label: t("gateway.rootCustom") },
          ]}
        />
        {gw.rootMode.value === "official" ? (
          <div class="settings-modal__pairing-row">
            <code class="settings-modal__pairing-value">{GATEWAY_OFFICIAL_ROOT}</code>
          </div>
        ) : (
          <>
            <div class="gateway-settings__root-edit">
              <HkInput
                modelValue={gw.rootDraft.value}
                onUpdate:modelValue={(v: string) => (gw.rootDraft.value = v)}
                placeholder="https://gateway.example.com/gateway/"
                spellcheck={false}
                submitOnEnter={() => void gw.saveCustomRoot(gw.rootDraft.value)}
              />
              <HkButton
                size="sm"
                variant="primary"
                loading={gw.rootBusy.value}
                disabled={gw.rootBusy.value || !gw.rootDraft.value.trim()}
                onClick={() => void gw.saveCustomRoot(gw.rootDraft.value)}
              >
                {t("gateway.rootSave")}
              </HkButton>
            </div>
            <HkSettingsHint>{t("gateway.rootConnectExistingHint")}</HkSettingsHint>
            {!isMobileApp() ? (
              <div class="settings-modal__pairing-open">
                <HkButton variant="secondary" onClick={() => (gw.wizardOpen.value = true)}>
                  <Rocket size={15} />
                  {t("gateway.selfhostOpen")}
                </HkButton>
                <HkSettingsHint>{t("gateway.rootDeployHint")}</HkSettingsHint>
              </div>
            ) : null}
          </>
        )}
        {gw.rootError.value ? (
          <p class="gateway-settings__error">{tError(gw.rootError.value)}</p>
        ) : (
          <HkSettingsHint>{t("gateway.rootHint")}</HkSettingsHint>
        )}
      </>
    );

    /** The desktop status pill (publish phase + detail). */
    const status = computed(() => phaseVoice(gateway.pubPhase));

    return () =>
      isMobileApp() ? (
        <>
          {/* phone pairing — the PHONE (client) side. The gateway route
              entry (custom domain for self-host) rides on top; the
              paired-computers management below is unchanged. */}
          <HkSettingsGroup title={t("gateway.phoneSectionTitle")}>
            {renderRoot()}
          </HkSettingsGroup>
          <HkSettingsGroup title={t("settings.pairingMobile")}>
            <HkSettingsHint>{t("settings.pairingMobileHint")}</HkSettingsHint>
            <div class="settings-modal__pairing-open">
              <HkButton variant="primary" onClick={pairing.openPairingWizard}>
                <Smartphone size={15} />
                {t("settings.pairingOpenWizard")}
              </HkButton>
            </div>
            {pairingStore.hosts.length > 0 ? (
              <>
                <HkSettingsSub title={t("settings.pairingPairedHosts")} />
                <ul class="settings-modal__paired-hosts">
                  {pairingStore.hosts.map((h) => (
                    <li key={entryKey(h)} class="settings-modal__paired-host">
                      <span class="settings-modal__paired-host-body">
                        <span class="settings-modal__paired-host-label">{h.label}</span>
                        <span class="settings-modal__paired-host-meta">
                          {h.lastSeen > 0
                            ? t("settings.pairingLastSynced", {
                                time: new Date(h.lastSeen).toLocaleString(),
                              })
                            : t("settings.pairingNeverSynced")}
                        </span>
                      </span>
                      <HkButton
                        size="sm"
                        variant="secondary"
                        ariaLabel={t("settings.pairingForget")}
                        onClick={() => pairingStore.removeEntry(h)}
                      >
                        {t("settings.pairingForget")}
                      </HkButton>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </HkSettingsGroup>
        </>
      ) : (
        <>
          {/* desktop — the gateway push service (§5). */}
          <HkSettingsGroup title={t("gateway.sectionTitle")}>
            <HkSettingsHint>{t("gateway.serviceHint")}</HkSettingsHint>

            {renderRoot()}

            <HkSettingsSub title={t("gateway.serviceToggle")} />
            {/* The channel the service publishes to — the session-resolved
                identity (falls back to the active account); no account →
                the toggle explains itself instead of starting nothing. */}
            {shownPlayer.value && shownPlayer.value.accountId != null ? (
              <p class="gateway-settings__channel">
                <HkTag variant="default" size="sm">
                  {shownPlayer.value.realm.toUpperCase()}
                </HkTag>
                <span class="gateway-settings__channel-name">
                  {shownPlayer.value.nickname}
                </span>
              </p>
            ) : (
              <HkAlert variant="warning" size="sm" message={t("gateway.noAccount")} />
            )}
            <HkTabs
              block
              variant="segmented"
              modelValue={gateway.config.enabled ? "on" : "off"}
              onUpdate:modelValue={(v: string) =>
                void gw.setEnabled(v === "on")
              }
              tabs={[
                { key: "off", label: t("gateway.serviceOff") },
                { key: "on", label: t("gateway.serviceOn") },
              ]}
            />
            {gw.toggleBusy.value ? (
              <p class="settings-modal__pairing-busy">
                <HkSpinner size="sm" tone="current" />
              </p>
            ) : null}
            {/* Gateway status: the publish socket's phase + detail. */}
            <div class="gateway-settings__status">
              <span class={["gateway-settings__pill", "is-" + status.value.tone]}>
                {status.value.label}
              </span>
              {gateway.pubDetail ? (
                <span class="gateway-settings__status-detail">
                  {tError(gateway.pubDetail)}
                </span>
              ) : null}
            </div>
            {gateway.config.enabled && gateway.pubPhase === "captcha" ? (
              <HkSettingsHint>{t("gateway.captchaPendingHint")}</HkSettingsHint>
            ) : null}

            {/* Self-host wizard entry (desktop-only). */}
            <div class="settings-modal__pairing-open">
              <HkButton variant="secondary" onClick={() => (gw.wizardOpen.value = true)}>
                <Rocket size={15} />
                {t("gateway.selfhostOpen")}
              </HkButton>
            </div>
          </HkSettingsGroup>

          {/* The wizard window (desktop-only surface). */}
          <SelfhostWizard
            modelValue={gw.wizardOpen.value}
            onUpdate:modelValue={(v: boolean) => (gw.wizardOpen.value = v)}
          />
        </>
      );
  },
});
