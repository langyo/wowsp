/** Pairing settings section — the gateway-push surface (route entry +
 *  mobile service + self-host wizard). The LEGACY LAN pairing is gone
 *  from the UI entirely, and the PIN pairing mode is retired end to end
 *  (2026-11-13): no wizard, no paired-computers list, no code display.
 *  Phone build renders the PHONE (client) side: the route entry field
 *  (custom domain for self-host) only; the wizard stays desktop-only
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
import { Rocket } from "@lucide/vue";
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
import SelfhostWizard from "@/components/settings/SelfhostWizard";
import { isMobileApp } from "@/utils/platform";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import "./gatewaySettings.scss";

/** The publish status pill's voice (phase → tone + label). Exported for
 *  the live view's compact pairing surface (PhonePairingEntry), so the
 *  phase naming lives in exactly one place across both surfaces. */
export function phaseVoice(phase: string): { tone: string; label: string } {
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
    const { gateway: gw } = props.ctx;
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
        {gw.rootMode.value === "official" ? null : (
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
            <p class="gateway-settings__hint-sm">{t("gateway.rootConnectExistingHint")}</p>
            {!isMobileApp() ? (
              <div class="settings-modal__pairing-open">
                <HkButton variant="secondary" onClick={() => (gw.wizardOpen.value = true)}>
                  <Rocket size={15} />
                  {t("gateway.selfhostOpen")}
                </HkButton>
                <p class="gateway-settings__hint-sm">{t("gateway.rootDeployHint")}</p>
              </div>
            ) : null}
            {gw.rootError.value ? (
              <p class="gateway-settings__error">{tError(gw.rootError.value)}</p>
            ) : null}
          </>
        )}
      </>
    );

    /** The desktop status pill (publish phase + detail). */
    const status = computed(() => phaseVoice(gateway.pubPhase));

    return () =>
      isMobileApp() ? (
        <>
          {/* phone pairing — the PHONE (client) side. The gateway route
              entry (custom domain for self-host) is all that remains:
              the paired-computers list went away with the PIN pairing
              mode (the phone imports replay files directly). */}
          <HkSettingsGroup title={t("gateway.phoneSectionTitle")}>
            {renderRoot()}
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
                <HkTag variant="default" size="sm">
                  {shownPlayer.value.nickname}
                </HkTag>
                <HkTag
                  variant="default"
                  size="sm"
                  class={["gateway-settings__phase-tag", "is-" + status.value.tone]}
                >
                  {status.value.label}
                </HkTag>
                {gateway.pubPhase === "error" && gateway.pubDetail ? (
                  <span class="gateway-settings__status-detail">
                    {tError(gateway.pubDetail)}
                  </span>
                ) : null}
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
            {gateway.config.enabled && gateway.pubPhase === "captcha" ? (
              <HkSettingsHint>{t("gateway.captchaPendingHint")}</HkSettingsHint>
            ) : null}
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
