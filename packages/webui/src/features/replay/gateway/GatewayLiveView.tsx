/** GatewayLiveView — the /live page body on the PHONE build: the
 *  account-routed receive side of gateway push (§6). The page auto-enters
 *  the WAITING state on mount (viewing is free — no connection until the
 *  user taps 开始连接), showing the active-account chip, the configured
 *  route entry and the waiting-for-battle hint. The connect button drives
 *  the handshake (health resolve → captcha bottom sheet when the node
 *  demands Turnstile → password sheet when it demands one → subscribe);
 *  pushed battle frames render through the EXISTING LiveBattlePanel with
 *  the mapped ArenaInfo, and host online/offline + bye flip the waiting /
 *  ended hints. Connection failures to a CUSTOM root surface as top-right
 *  toasts (see useGatewayLive).
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
import { Power, RefreshCw, Smartphone } from "@lucide/vue";

import { t } from "@/i18n";
import AccountAvatar from "@/components/base/AccountAvatar";
import PlayerBadge from "@/components/base/PlayerBadge";
import LiveBattlePanel from "@/features/replay/LiveBattlePanel";
import { useGatewayStore } from "@/stores/gateway";
import { useShownPlayer } from "@/composables/useShownPlayer";
import { useGatewayLive } from "./useGatewayLive";

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

    /** The waiting screen's status pill voice. */
    const statusVoice = computed(() => {
      switch (gateway.subPhase) {
        case "resolving":
        case "connecting":
          return { tone: "pending", text: t("gateway.connecting") };
        case "online":
          return { tone: "online", text: t("gateway.online") };
        case "error":
          return { tone: "error", text: t("gateway.errorState") };
        default:
          return { tone: "idle", text: t("gateway.idleState") };
      }
    });
    const connected = computed(() => gateway.subPhase === "online");

    /** The waiting hint: desktop presence first (the host is offline →
     *  ask for the desktop side), then battle-over retention, then the
     *  plain waiting-for-battle line. */
    const waitingHint = computed(() => {
      if (gateway.hostOnline === false) return t("gateway.waitingHost");
      if (live.ended.value) return t("gateway.battleEndedHint");
      return t("gateway.waitingBattle");
    });

    return () => (
      <div class="gateway-live">
        {/* The waiting head: account chip + route entry + status pill.
            Stays rendered above the panel too, so the stop button and the
            connection voice remain reachable mid-battle. */}
        <div class="gateway-live__head">
          <div class="gateway-live__account">
            {dogTag.value ? (
              <PlayerBadge dogTag={dogTag.value} size={28} />
            ) : (
              <AccountAvatar size={28} />
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
          </div>
          <div class="gateway-live__meta">
            <Smartphone size={13} class="gateway-live__meta-icon" />
            <code class="gateway-live__root">{gateway.config.root}</code>
            <span
              class={["gateway-live__pill", "is-" + statusVoice.value.tone]}
              data-hint={gateway.subDetail ?? undefined}
              data-hint-pos="bottom"
            >
              {statusVoice.value.text}
            </span>
          </div>
        </div>

        {/* Connect / disconnect — viewing is free; the button owns the
            socket (§6.1). */}
        <div class="gateway-live__actions">
          {connected.value ? (
            <HkButton size="sm" variant="secondary" onClick={() => void live.disconnect()}>
              <Power size={14} />
              {t("gateway.disconnect")}
            </HkButton>
          ) : (
            <HkButton
              size="sm"
              variant="primary"
              loading={live.connecting.value}
              disabled={!live.route.value || live.connecting.value}
              onClick={() => void live.connect()}
            >
              <RefreshCw size={14} />
              {t("gateway.connect")}
            </HkButton>
          )}
        </div>

        {live.inlineErrorText.value ? (
          <p class="gateway-live__error">{live.inlineErrorText.value}</p>
        ) : null}

        {/* The pushed battle: the EXISTING panel over the mapped ArenaInfo
            (relation → teams), ended flag on bye. Before the first frame
            the waiting hint holds the body. */}
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
            <p class="gateway-live__waiting-hint">{waitingHint.value}</p>
            {gateway.subPhase === "resolving" || gateway.subPhase === "connecting" ? (
              <p class="gateway-live__busy">
                <HkSpinner size="xs" tone="current" />
              </p>
            ) : null}
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
              <p class="gateway-live__busy">
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
