/**
 * PhonePairingEntry — the live view's phone-pairing entry point
 * (user-requested): ONE icon pill mounted in BOTH faces of
 * LiveBattlePanel — the waiting placeholder (before/without a battle)
 * and the head row's action cluster (while a battle runs) — that opens
 * the pairing flow for the build it runs on:
 *
 * - PHONE build: deep-links to /replay?pairing=1, the same route the
 *   phone settings' pairing section uses — ReplayView auto-opens the
 *   PairingWizard (LAN discovery + the internet PIN flow for pulling
 *   replays from the desktop).
 * - DESKTOP: opens a compact HkModal (docked as a bottom sheet under
 *   768px, though desktop never gets that narrow) that surfaces the
 *   HANDSHAKE ESSENTIALS of today's account-routed gateway push —
 *   NOT the retired relay pairing code: since #1544 the phone
 *   authorizes by ADDRESSING the desktop's session-hub route (the
 *   account identity below) and passing the gateway's own challenge
 *   (Turnstile / password) on its Live page's connect button, so the
 *   desktop side of a successful handshake is exactly "the mobile
 *   service is online on this account". The modal therefore shows the
 *   channel identity, the service toggle (the very segmented control
 *   the settings section renders — one shared composable, so the
 *   captcha-demand path still lands on the sidebar's pinned challenge
 *   card), the publish phase, the linked-phone count, the route entry
 *   and a jump into the full settings section. No PIN is displayed —
 *   the code relay survives only for old phone builds (replay pulls).
 */
import { computed, defineComponent, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { SlidersHorizontal, Smartphone } from "@lucide/vue";
import {
  HkAlert,
  HkButton,
  HkModal,
  HkSpinner,
  HkTabs,
  HkTag,
} from "@celestia-island/hikari";

import AppTag, { type AppTagTone } from "@/components/base/AppTag";
import { t, tError } from "@/i18n";
import { isMobileApp } from "@/utils/platform";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { useSettingsGatewayState } from "@/components/settings/useSettingsGatewayState";
import { phaseVoice } from "@/components/settings/sections/PairingSection";
import "./PhonePairingEntry.scss";

/** The publish-phase voice mapped onto AppTag's tones (the label logic —
 * phaseVoice — is shared with the settings section; only the primitive
 * differs, so a phase rename lands on both surfaces). */
const PHASE_TONE: Record<string, AppTagTone> = {
  pending: "warning",
  online: "success",
  error: "danger",
  idle: "default",
};

/** The desktop compact pairing surface (see the file header). Mounted by
 * the entry alone — never exported for other hosts; the settings section
 * stays the full-fat surface. */
const PhonePairingModal = defineComponent({
  name: "PhonePairingModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    // The VERY state/composable the settings section's toggle runs on:
    // route derivation (shown player), captcha-aware enable/disable, the
    // gateway store's live phases. One shared brain, two surfaces.
    const gw = useSettingsGatewayState();
    const gateway = gw.gateway;
    const settings = useSettingsUiStore();

    // The modal may open long after the publisher's transitions — read
    // the snapshot once (exactly the tray panel's rationale); the store's
    // wowsp://gateway-state listener keeps it live from there.
    onMounted(() => void gateway.refreshPublishStatus());

    const phase = computed(() => phaseVoice(gateway.pubPhase));

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("replay.live.pairingModalTitle")}
        width="sm"
      >
        <div class="phone-pairing">
          {/* The one-paragraph "how pairing works today" — the same hint
              the settings section leads with. */}
          <p class="phone-pairing__intro">{t("gateway.serviceHint")}</p>

          {/* The channel identity: the account whose battles are pushed —
              the phone must hold the SAME account to land on this route. */}
          {gw.shownPlayer.value && gw.shownPlayer.value.accountId != null ? (
            <div class="phone-pairing__channel">
              <HkTag variant="default" size="sm">
                {gw.shownPlayer.value.realm.toUpperCase()}
              </HkTag>
              <HkTag variant="default" size="sm">
                {gw.shownPlayer.value.nickname}
              </HkTag>
              <AppTag
                face="soft"
                tone={PHASE_TONE[phase.value.tone] ?? "default"}
                data-hint={gateway.pubDetail ?? undefined}
              >
                {phase.value.label}
              </AppTag>
              {gateway.pubPhase === "error" && gateway.pubDetail ? (
                <span class="phone-pairing__detail">{tError(gateway.pubDetail)}</span>
              ) : null}
              {gateway.config.enabled && gateway.pubPhase === "online" ? (
                <span class="phone-pairing__subs">
                  {gateway.pubSubscribers > 0
                    ? t("tray.phoneLinked", { n: gateway.pubSubscribers })
                    : t("tray.phoneWaiting")}
                </span>
              ) : null}
            </div>
          ) : (
            <HkAlert variant="warning" size="sm" message={t("gateway.noAccount")} />
          )}

          {/* The service toggle — the segmented control the settings
              section renders, driving the same setEnabled (enable =
              persist + publish on the session-hub route; a captcha demand
              pins the sidebar's challenge card). */}
          <p class="phone-pairing__sub">{t("gateway.serviceToggle")}</p>
          <HkTabs
            block
            variant="segmented"
            modelValue={gateway.config.enabled ? "on" : "off"}
            onUpdate:modelValue={(v: string) => void gw.setEnabled(v === "on")}
            tabs={[
              { key: "off", label: t("gateway.serviceOff") },
              { key: "on", label: t("gateway.serviceOn") },
            ]}
          />
          {gw.toggleBusy.value ? (
            <p class="phone-pairing__busy">
              <HkSpinner size="sm" tone="current" />
            </p>
          ) : null}
          {gateway.config.enabled && gateway.pubPhase === "captcha" ? (
            <p class="phone-pairing__captcha">{t("gateway.captchaPendingHint")}</p>
          ) : null}

          {/* The route entry the phone must reach — the official default,
              or the custom root a self-hosted deployment serves. */}
          <div class="phone-pairing__root">
            <span class="phone-pairing__root-label">{t("gateway.phoneSectionTitle")}</span>
            <code class="phone-pairing__root-value">{gateway.config.root}</code>
          </div>

          <div class="phone-pairing__foot">
            <HkButton
              size="sm"
              variant="ghost"
              onClick={() => {
                emit("update:modelValue", false);
                settings.show("pairing");
              }}
            >
              <SlidersHorizontal size={13} />
              {t("replay.live.pairingModalOpenSettings")}
            </HkButton>
          </div>
        </div>
      </HkModal>
    );
  },
});

export default defineComponent({
  name: "PhonePairingEntry",
  inheritAttrs: false,
  props: {
    /** Labeled face — the waiting placeholder's quiet CTA (icon + text).
     * The default is the head row's icon-only pill; both carry the
     * aria-label and data-hint tooltip. */
    labeled: { type: Boolean, default: false },
  },
  setup(props, { attrs }) {
    const router = useRouter();
    // Decided once, on setup — the repo's build-gate convention.
    const phone = isMobileApp();
    const open = ref(false);

    function onClick() {
      if (phone) {
        // The wizard lives in the replay view — deep-link the same way
        // the phone settings' pairing section does (?pairing=1 makes
        // ReplayView auto-open the PairingWizard).
        void router.push({ path: "/replay", query: { pairing: "1" } });
        return;
      }
      open.value = true;
    }

    return () => {
      const hint = phone
        ? t("replay.live.pairingEntryHintPhone")
        : t("replay.live.pairingEntryHintDesktop");
      return (
        <>
          <AppTag
            {...attrs}
            interactive
            face="outline"
            class={["phone-pairing-entry", attrs.class]}
            aria-label={hint}
            data-hint={hint}
            onClick={onClick}
          >
            <Smartphone size={13} />
            {props.labeled ? t("replay.live.pairingEntry") : null}
          </AppTag>
          {phone ? null : (
            <PhonePairingModal
              modelValue={open.value}
              onUpdate:modelValue={(v: boolean) => (open.value = v)}
            />
          )}
        </>
      );
    };
  },
});
