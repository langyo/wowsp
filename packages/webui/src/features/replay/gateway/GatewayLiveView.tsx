/** GatewayLiveView — the /live page body on the PHONE build: the
 *  account-routed receive side of gateway push (§6). The page auto-enters
 *  the WAITING state on mount (viewing is free — no connection until the
 *  user taps 开始连接). Two glass surfaces ride over the wallpaper:
 *
 *  - the head card — account chip, connection-status tag and the route
 *    entry (plus a compact disconnect once a battle is on screen);
 *  - the state hero (until the first pushed frame) — a per-state art
 *    (GatewayLinkArt idle / WaitingRadarArt live / icon disc otherwise),
 *    a headline + hint, and the BIG connect CTA (the old floating one-liner
 *    was unreadable over a wallpaper and hid the primary action behind a
 *    tiny button).
 *
 *  The connect button drives the handshake (health resolve → captcha bottom
 *  sheet when the node demands Turnstile → password sheet when it demands
 *  one → subscribe); pushed battle frames render through the EXISTING
 *  LiveBattlePanel with the mapped ArenaInfo, and host online/offline + bye
 *  flip the hero's voice. Connection failures to a CUSTOM root surface as
 *  top-right toasts (see useGatewayLive).
 *
 *  HkModal docks as a bottom sheet under 768px automatically — the phone
 *  build is always under it there, so the captcha/password surfaces ride
 *  plain HkModals.
 */
import { computed, defineComponent, ref, watch } from "vue";
import {
  HkButton,
  HkCaptchaWidget,
  HkInput,
  HkModal,
  HkSpinner,
} from "@celestia-island/hikari";
import {
  Hourglass,
  MonitorOff,
  MonitorSmartphone,
  Power,
  RefreshCw,
  TriangleAlert,
} from "@lucide/vue";

import AppTag, { type AppTagTone } from "@/components/base/AppTag";
import { t } from "@/i18n";
import AccountAvatar from "@/components/base/AccountAvatar";
import PlayerBadge from "@/components/base/PlayerBadge";
import LiveBattlePanel from "@/features/replay/LiveBattlePanel";
import {
  GatewayLinkArt,
  WaitingRadarArt,
} from "@/features/replay/liveGuideArt";
import { useGatewayStore } from "@/stores/gateway";
import { useShownPlayer } from "@/composables/useShownPlayer";
import { useGatewayLive } from "./useGatewayLive";
import "./GatewayLiveView.scss";

export default defineComponent({
  name: "GatewayLiveView",
  setup() {
    const gateway = useGatewayStore();
    const live = useGatewayLive();
    const { dogTag } = useShownPlayer();
    void gateway.loadConfig();
    /** The password sheet's field (kept here so Enter and the submit
        button share one value; cleared whenever the sheet re-opens). */
    const pw = ref("");
    // A fresh password ask starts with an empty field (a re-opened sheet
    // after a rejected dial must not keep the wrong value selected).
    watch(
      () => live.passwordSheetOpen.value,
      (open) => {
        if (open) pw.value = "";
      },
    );

    const connected = computed(() => gateway.subPhase === "online");

    /** The head card's status tag voice (tone rides AppTag's faces). */
    const statusVoice = computed<{ tone: AppTagTone; text: string }>(() => {
      switch (gateway.subPhase) {
        case "resolving":
        case "connecting":
          return { tone: "warning", text: t("gateway.connecting") };
        case "online":
          return { tone: "success", text: t("gateway.online") };
        case "error":
          return { tone: "danger", text: t("gateway.errorState") };
        default:
          return { tone: "default", text: t("gateway.idleState") };
      }
    });

    /** The hero's voice — the steady state the waiting card speaks.
     *  Desktop presence first (the host is offline → ask for the desktop
     *  side), then battle-over retention, then the connected / idle /
     *  connecting pair. Dial errors keep their dedicated paragraph below
     *  the head card (the status tag already turns red) — the hero only
     *  ever speaks steady states, exactly like the old waiting hint. */
    const heroVoice = computed(() => {
      if (gateway.hostOnline === false)
        return { tone: "offline", title: t("gateway.heroOfflineTitle"), hint: t("gateway.waitingHost") };
      if (live.ended.value)
        return { tone: "ended", title: t("gateway.heroEndedTitle"), hint: t("gateway.battleEndedHint") };
      if (connected.value)
        return { tone: "live", title: t("gateway.heroWaitingTitle"), hint: t("gateway.waitingBattle") };
      return { tone: "idle", title: t("gateway.heroIdleTitle"), hint: t("gateway.heroIdleHint") };
    });

    /** The dial is visibly in flight while the handshake runs or the
     *  socket phase machine is resolving/connecting — the link art then
     *  animates and a busy line rides under the hint. */
    const dialing = computed(
      () =>
        live.connecting.value ||
        gateway.subPhase === "resolving" ||
        gateway.subPhase === "connecting",
    );

    /** The hero's art slot per voice: the device-link art while idle
     *  (animated while dialing), the battle radar while connected, and a
     *  tinted icon disc for the two quiet states. */
    const heroMedia = () => {
      if (heroVoice.value.tone === "live")
        return <WaitingRadarArt class="gateway-live__hero-art" />;
      if (heroVoice.value.tone === "idle")
        return <GatewayLinkArt flow={dialing.value} class="gateway-live__hero-art" />;
      const icon =
        heroVoice.value.tone === "offline" ? (
          <MonitorOff size={24} />
        ) : heroVoice.value.tone === "ended" ? (
          <Hourglass size={24} />
        ) : (
          <TriangleAlert size={24} />
        );
      return (
        <span class={["gateway-live__hero-disc", `gateway-live__hero-disc--${heroVoice.value.tone}`]}>
          {icon}
        </span>
      );
    };

    return () => (
      <div class="gateway-live">
        {/* The head card: account chip + status tag, then the route entry.
            Stays rendered above the panel too, so the disconnect affordance
            and the connection voice remain reachable mid-battle. */}
        <div class="gateway-live__head">
          <div class="gateway-live__account">
            {dogTag.value ? (
              <PlayerBadge dogTag={dogTag.value} size={32} />
            ) : (
              <AccountAvatar size={32} />
            )}
            <span class="gateway-live__account-body">
              <span class="gateway-live__account-name">
                {live.shownPlayer.value?.nickname ?? t("account.notBound")}
              </span>
              <span class="gateway-live__account-realm">
                {live.shownPlayer.value
                  ? live.shownPlayer.value.realm.toUpperCase()
                  : ""}
              </span>
            </span>
            <AppTag
              class="gateway-live__status"
              face={connected.value ? "solid" : "soft"}
              tone={statusVoice.value.tone}
              data-hint={gateway.subDetail ?? undefined}
              data-hint-pos="bottom"
            >
              {statusVoice.value.text}
            </AppTag>
          </div>
          <div class="gateway-live__route">
            <MonitorSmartphone size={13} class="gateway-live__route-icon" />
            <code class="gateway-live__root">{gateway.config.root}</code>
            {live.arena.value ? (
              <HkButton
                class="gateway-live__kick"
                size="sm"
                variant="secondary"
                onClick={() => void live.disconnect()}
              >
                <Power size={13} />
                {t("gateway.disconnect")}
              </HkButton>
            ) : null}
          </div>
        </div>

        {live.inlineErrorText.value ? (
          <p class="gateway-live__error">{live.inlineErrorText.value}</p>
        ) : null}

        {/* The pushed battle: the EXISTING panel over the mapped ArenaInfo
            (relation → teams), ended flag on bye. Before the first frame
            the state hero holds the body. */}
        {live.arena.value ? (
          <div class="gateway-live__body">
            <LiveBattlePanel
              arena={live.arena.value}
              ended={live.ended.value}
              realm={live.battleRealm.value}
            />
          </div>
        ) : (
          <div class="gateway-live__waiting">
            <div class={["gateway-live__hero", `gateway-live__hero--${heroVoice.value.tone}`]}>
              {heroMedia()}
              <h3 class="gateway-live__hero-title">{heroVoice.value.title}</h3>
              <p class="gateway-live__hero-hint">{heroVoice.value.hint}</p>
              {dialing.value && !connected.value ? (
                <p class="gateway-live__hero-busy">
                  <HkSpinner size="xs" tone="current" />
                  {t("gateway.connecting")}
                </p>
              ) : null}
              {/* Connect / disconnect — viewing is free; the button owns
                  the socket (§6.1). */}
              <div class="gateway-live__hero-cta">
                {connected.value ? (
                  <HkButton
                    block
                    size="lg"
                    variant="secondary"
                    onClick={() => void live.disconnect()}
                  >
                    <Power size={15} />
                    {t("gateway.disconnect")}
                  </HkButton>
                ) : (
                  <HkButton
                    block
                    size="lg"
                    variant="primary"
                    loading={live.connecting.value}
                    disabled={!live.route.value || live.connecting.value}
                    onClick={() => void live.connect()}
                  >
                    <RefreshCw size={15} />
                    {t("gateway.connect")}
                  </HkButton>
                )}
              </div>
              {!live.route.value ? (
                <p class="gateway-live__hero-foot">{t("gateway.heroNoRoute")}</p>
              ) : null}
            </div>
          </div>
        )}

        {/* Captcha bottom sheet — mounted only while the flow demands it;
            the widget itself mounts only once the doc's sitekey landed
            (async-sitekey guard; empty configured key → placeholder). */}
        <HkModal
          modelValue={live.captchaSheetOpen.value}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) live.captchaSheetOpen.value = false;
          }}
          title={t("gateway.captchaSheetTitle")}
          width="sm"
        >
          {{
            default: () => (
              <div class="gateway-live__sheet">
                <p class="gateway-live__sheet-hint">{t("gateway.captchaHint")}</p>
                {live.captchaSiteKey.value !== null ? (
                  <HkCaptchaWidget
                    siteKey={live.captchaSiteKey.value}
                    attempt={live.captchaAttempt.value}
                    onVerify={(token: string) => live.onCaptchaVerified(token)}
                  />
                ) : (
                  <p class="gateway-live__sheet-busy">
                    <HkSpinner size="xs" tone="current" />
                    {t("gateway.captchaLoading")}
                  </p>
                )}
              </div>
            ),
          }}
        </HkModal>

        {/* Password bottom sheet — the hikari password surface + submit;
            a wrong password rejects the dial and the flow re-opens the
            sheet (the state machine keeps the creds per attempt). */}
        <HkModal
          modelValue={live.passwordSheetOpen.value}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) live.passwordSheetOpen.value = false;
          }}
          title={t("gateway.passwordSheetTitle")}
          width="xs"
        >
          {{
            default: () => (
              <form
                class="gateway-live__sheet"
                onSubmit={(e: Event) => {
                  e.preventDefault();
                  live.onPasswordSubmit(pw.value);
                }}
              >
                <p class="gateway-live__sheet-hint">{t("gateway.passwordHint")}</p>
                <HkInput
                  modelValue={pw.value}
                  onUpdate:modelValue={(v: string) => (pw.value = v)}
                  variant="password"
                  placeholder={t("gateway.passwordLabel")}
                  submitOnEnter={() => live.onPasswordSubmit(pw.value)}
                />
                <HkButton
                  block
                  loading={live.passwordBusy.value}
                  disabled={live.passwordBusy.value || !pw.value}
                  onClick={() => live.onPasswordSubmit(pw.value)}
                >
                  {t("gateway.passwordSubmit")}
                </HkButton>
              </form>
            ),
          }}
        </HkModal>
      </div>
    );
  },
});
