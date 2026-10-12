/** Pairing settings section — phone build renders the PHONE (client) side,
 *  desktop the SERVER side (same slot, two dressings). */
import { defineComponent, type PropType } from "vue";
import { Copy, RefreshCw, Smartphone, Trash2 } from "@lucide/vue";
import {
  HkAlert,
  HkButton,
  HkOtpInput,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSpinner,
  HkTabs,
  HkTag,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import { entryKey } from "@/stores/pairing";
import { isMobileApp } from "@/utils/platform";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

export default defineComponent({
  name: "SettingsPairingSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { pairing } = props.ctx;
    const pairingStore = pairing.pairingStore;
    return () =>
          isMobileApp() ? (
          <>
          {/* phone pairing — the PHONE (client) side. Discoverability
              first: the section the owner could not find. One primary
              action opens the replay view's pairing wizard (deep-linked
              via ?pairing=1), plus the paired computers with forget
              buttons and last-synced info. */}
          <HkAlert variant="warning" size="sm" message={t("settings.pairingWip")} />
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
                        <Trash2 size={14} />
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
          {/* phone pairing — the DESKTOP side. Runs the pairing server the
              mobile app connects to: toggle on, then read the code into the
              phone's replay → "get from PC" wizard. The displayed code is
              the GATEWAY-ALLOCATED pairing code while the built-in internet
              gateway is online (relay mode); when it is unreachable the
              desktop falls back to its LAN PIN and shows a LAN-only hint.
              There is deliberately NO relay URL field: the gateway endpoint
              is built into both apps. */}
          <HkAlert variant="warning" size="sm" message={t("settings.pairingWip")} />
          <HkSettingsGroup title={t("settings.pairing")}>
            <HkSettingsHint>{t("settings.pairingHint")}</HkSettingsHint>
            <HkTabs
              block
              variant="segmented"
              modelValue={pairingStore.server?.running ? "on" : "off"}
              onUpdate:modelValue={(v: string) =>
                void (v === "on" ? pairingStore.startServer() : pairingStore.stopServer())
              }
              tabs={[
                { key: "off", label: t("settings.pairingOff") },
                { key: "on", label: t("settings.pairingOn") },
              ]}
            />
            {pairingStore.serverBusy ? (
              <p class="settings-modal__pairing-busy">
                <HkSpinner size="sm" tone="current" />
              </p>
            ) : null}
            {pairingStore.serverError ? (
              <p class="settings-modal__pack-error">{pairingStore.serverError}</p>
            ) : null}
            {pairingStore.server?.running ? (
              <div class="settings-modal__pairing-live">
                {/* The code is the whole pairing UX on the phone side — show
                    it big through the same hikari OTP grid the phone types
                    into (readonly), with copy + regenerate actions. */}
                <div class="settings-modal__pairing-pin">
                  <HkOtpInput
                    length={6}
                    separated
                    size="lg"
                    readonly
                    modelValue={pairingStore.server.pin ?? ""}
                    ariaLabel={t("settings.pairingPin")}
                    style={{ "--hk-otp-font-size": "1.6rem" } as Record<string, string>}
                  />
                  <div class="settings-modal__pairing-pin-actions">
                    <HkButton
                      size="sm"
                      variant="secondary"
                      ariaLabel={t("settings.pairingPinCopy")}
                      onClick={() => void pairing.copyPin(pairingStore.server?.pin ?? "")}
                    >
                      <Copy size={14} />
                      {t("settings.pairingPinCopy")}
                    </HkButton>
                    <HkButton
                      size="sm"
                      variant="secondary"
                      loading={pairing.reallocBusy.value}
                      disabled={!pairingStore.server.relayOnline}
                      ariaLabel={t("settings.pairingRegenerate")}
                      onClick={() => void pairing.regenerateCode()}
                    >
                      <RefreshCw size={14} />
                      {t("settings.pairingRegenerate")}
                    </HkButton>
                  </div>
                </div>
                <HkSettingsHint>
                  {pairingStore.server.relayOnline
                    ? t("settings.pairingPhoneHintInternet")
                    : t("settings.pairingPhoneHint")}
                </HkSettingsHint>
                {/* Gateway status: relay mode vs the LAN-only fallback. */}
                {pairingStore.server.relayOnline ? (
                  <p class="settings-modal__pairing-mode">
                    <HkTag variant="success" size="sm">{t("settings.pairingModeRelay")}</HkTag>
                  </p>
                ) : (
                  <p class="settings-modal__packs-banner">{t("settings.pairingLanOnly")}</p>
                )}
                {/* Address: auxiliary small print — discovery makes typing it
                    unnecessary on a normal LAN; kept for manual fallback. */}
                <div class="settings-modal__pairing-row">
                  <span class="settings-modal__pairing-label">
                    {t("settings.pairingAddress")}
                  </span>
                  {/* Selectable text — the manual fallback copies from here. */}
                  <code class="settings-modal__pairing-value">
                    {pairingStore.server.host}:{pairingStore.server.port}
                  </code>
                </div>
              </div>
            ) : (
              <HkSettingsHint>{t("settings.pairingIdleHint")}</HkSettingsHint>
            )}
          </HkSettingsGroup>
          </>
          );
  },
});
