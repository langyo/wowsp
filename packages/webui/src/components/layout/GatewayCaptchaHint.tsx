/**
 * GatewayCaptchaHint — the desktop sidebar's gateway-push challenge card,
 * cloned from PluginUpdateHint's anchored-card mechanics (fixed, teleported
 * to body, anchored to the RIGHT of the sidebar footer's game-status card
 * via the shared statusCardEl ref, z-tooltip band, minimize parks it).
 *
 * While the mobile service is ON and the node demands an unsolved Turnstile
 * (the pub socket's `captcha` phase on wowsp://gateway-state) the card is
 * PINNED open: its title tells the user to pass the challenge once — the
 * push starts only after a pass mints a ticket (§5.2). The body carries
 * hikari's HkCaptchaWidget, mounted only after the health document lands
 * (the async-sitekey guard from the console FeedbackApp: a widget mounted
 * against an empty sitekey stays a 0-height host forever), and the
 * `attempt` prop resets after every failed exchange so the widget remints
 * a fresh token. On verify, the token goes straight to
 * `gateway_publish_start` (the route derived from the session hub, kept
 * in the gateway store by the settings toggle).
 *
 * A minimize button in the card's top-right corner PARKS it — even when
 * pinned, a deliberate dismissal wins — until a settled hover on the
 * trigger (the sidebar's phone icon) brings it back.
 */
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  Teleport,
  watch,
  type PropType,
  type Ref,
} from "vue";
import {
  HkCaptchaWidget,
  HkSpinner,
  scheduleCronAfter,
  useToast,
  type CronHandle,
} from "@celestia-island/hikari";
import { AlertTriangle, Minus, ShieldCheck } from "@lucide/vue";

import { t, tError } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import { useShownPlayer } from "@/composables/useShownPlayer";
import { gatewayRoute } from "@/features/replay/gateway/gatewayBattle";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import "./GatewayCaptchaHint.scss";

/** Hover-in delay before the hint opens (the global tooltip's rhythm). */
const OPEN_DELAY_MS = 250;
/** Grace between leaving the trigger/popup and actually closing. */
const CLOSE_GRACE_MS = 180;
/** A parked (minimized) card returns only on a SETTLED hover on the
 *  trigger. Exported for the tests. */
export const REOPEN_DELAY_MS = 600;
/** Gap between the anchor card's right edge and the popup. */
const ANCHOR_GAP_PX = 10;
/** Viewport breathing room kept above/below the popup. */
const EDGE_PX = 8;

export default defineComponent({
  name: "GatewayCaptchaHint",
  props: {
    /** The element the popup anchors to — the sidebar's game-status
     *  card, so the popup floats beside it, vertically centered on it. */
    anchor: {
      type: Object as PropType<Ref<HTMLElement | null | undefined>>,
      default: undefined,
    },
  },
  setup(props, { slots, attrs }) {
    const gateway = useGatewayStore();
    const toast = useToast();
    const { shownPlayer } = useShownPlayer();
    // The root DPI zoom the popup's coordinate math runs against — see
    // applyStyle/place (PluginUpdateHint's conversion, verbatim).
    const dpiScale = useAppliedDpiScale();

    const open = ref(false);
    const popStyle = ref<{ left: string; top: string; transform: string } | null>(null);
    const wrapEl = ref<HTMLElement | null>(null);
    const popEl = ref<HTMLElement | null>(null);
    const hoverSpan = ref(false);
    const hoverPop = ref(false);
    let openTimer: CronHandle | undefined;
    let closeTimer: CronHandle | undefined;
    let reopenTimer: CronHandle | undefined;
    /** Parked by the minimize button: the card stays down — the pin's
     *  auto-open included — until a settled hover on the trigger unparks
     *  it. Per-mount state, deliberately not persisted. */
    const minimized = ref(false);
    let anchorLeft = 0;
    let anchorCenterY = 0;

    // ── the challenge state ────────────────────────────────────────────
    /** Pinned while the mobile service is on and the node demands an
     *  unsolved captcha (the pub socket's `captcha` phase). */
    const pinned = computed(
      () => gateway.config.enabled && gateway.pubPhase === "captcha",
    );
    /** The widget's sitekey — resolved from the health document once the
     *  card becomes relevant (async-sitekey guard); null until then. */
    const siteKey = ref<string | null>(null);
    const healthError = ref<string | null>(null);
    /** Bumped after every failed exchange so the widget remints. */
    const attempt = ref(0);
    const exchanging = ref(false);
    const exchangeError = ref<string | null>(null);

    async function resolveSiteKey(): Promise<void> {
      if (siteKey.value !== null || healthError.value !== null) return;
      try {
        const doc = await gateway.resolveHealth(gateway.config.root);
        siteKey.value = doc.auth.turnstile.sitekey ?? "";
      } catch (e) {
        healthError.value = e instanceof Error ? e.message : String(e);
      }
    }

    /** The publish route for the exchange: the store's latch (set by the
     *  settings toggle's start attempt), else derived here from the shown
     *  (session-resolved) player — one fallback so a boot-time captcha
     *  phase (service auto-resumed by Rust) still exchanges. */
    const routeForExchange = computed(() => {
      if (gateway.pubRoute) return gateway.pubRoute;
      const p = shownPlayer.value;
      return p && p.accountId != null ? gatewayRoute(p.realm, p.accountId) : null;
    });

    /** Hand the fresh token to the publisher. A captcha-failed rejection
     *  remints (attempt bump); custom-node failures additionally toast
     *  top-right (§5.4). */
    async function exchange(token: string): Promise<void> {
      const route = routeForExchange.value;
      if (!route || exchanging.value) return;
      exchanging.value = true;
      exchangeError.value = null;
      try {
        await gateway.startPublish(route, { turnstileToken: token });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        exchangeError.value = msg;
        if (/captcha/.test(msg)) {
          // The ticket was rejected — the challenge must run again.
          attempt.value += 1;
        }
        if (gateway.isCustomRoot) {
          toast.error(t("gateway.customNodeError", { detail: msg }));
        }
      } finally {
        exchanging.value = false;
      }
    }

    function onVerify(token: string): void {
      void exchange(token);
    }

    // ── anchored-card mechanics (PluginUpdateHint's, verbatim) ─────────
    function clearTimers(): void {
      openTimer?.disconnect();
      closeTimer?.disconnect();
      reopenTimer?.disconnect();
      openTimer = closeTimer = reopenTimer = undefined;
    }

    // The popup teleports to <body> — inside the root DPI zoom's subtree
    // — so its left/top live in the zoomed local space and paint scale×
    // larger: every visual-space measurement (gBCR, window.innerWidth /
    // innerHeight) is divided by the applied scale first, or the card
    // drifts scale× off its anchor (PluginUpdateHint's zoom notes).
    function applyStyle(): void {
      const half = (popEl.value?.offsetHeight ?? 0) / 2;
      const innerH = window.innerHeight / dpiScale.value;
      const top = Math.max(
        EDGE_PX + half,
        Math.min(anchorCenterY, innerH - EDGE_PX - half),
      );
      popStyle.value = {
        left: anchorLeft + "px",
        top: top + "px",
        transform: "translateY(-50%)",
      };
    }

    function place(): boolean {
      const rect = (props.anchor?.value ?? wrapEl.value)?.getBoundingClientRect();
      if (!rect) return false;
      const z = dpiScale.value;
      anchorLeft = Math.min(rect.right / z + ANCHOR_GAP_PX, window.innerWidth / z - 340);
      anchorCenterY = (rect.top + rect.height / 2) / z;
      applyStyle();
      return true;
    }

    async function show(): Promise<void> {
      // Parked: every auto-open yields to the dismissal — only the
      // trigger's settled hover (onEnter's reopen branch) unparks.
      if (minimized.value) return;
      if (!place()) {
        await nextTick();
        if (!place()) return;
      }
      open.value = true;
      void resolveSiteKey();
      await nextTick();
      if (open.value) applyStyle();
    }

    function close(): void {
      open.value = false;
      popStyle.value = null;
    }

    function minimize(): void {
      minimized.value = true;
      clearTimers();
      close();
    }

    /** A fresh captcha episode (phase re-entering `captcha` from a
     *  non-captcha state) must not inherit an old park — the challenge
     *  is mandatory before any push starts. */
    watch(
      () => gateway.pubPhase,
      (phase, was) => {
        if (phase === "captcha" && was !== "captcha") minimized.value = false;
      },
    );

    function onEnter(): void {
      hoverSpan.value = true;
      // The card is the challenge surface: only relevant while the
      // service is on (the icon's plain tooltip covers the other states).
      if (!gateway.config.enabled) return;
      clearTimers();
      if (minimized.value) {
        reopenTimer = scheduleCronAfter(() => {
          minimized.value = false;
          if (pinned.value) void show();
        }, REOPEN_DELAY_MS);
        return;
      }
      if (pinned.value) openTimer = scheduleCronAfter(() => void show(), OPEN_DELAY_MS);
    }

    function onLeave(): void {
      hoverSpan.value = false;
      openTimer?.disconnect();
      openTimer = undefined;
      reopenTimer?.disconnect();
      reopenTimer = undefined;
      closeTimer?.disconnect();
      closeTimer = scheduleCronAfter(() => {
        // A pinned card outlives the pointer — the reminder stays.
        if (!pinned.value) close();
      }, CLOSE_GRACE_MS);
    }

    // The pin flip opens the card by itself; the pin lifting closes it
    // unless the pointer is holding it open. The phase moving OFF captcha
    // (online / stopped) is the pass having landed — the card retires.
    watch(
      pinned,
      (p) => {
        if (p) void show();
        else if (!hoverSpan.value && !hoverPop.value) close();
      },
      { immediate: true, flush: "post" },
    );

    function onResize(): void {
      if (open.value) place();
    }
    window.addEventListener("resize", onResize);
    // A scale change never fires a resize event: while the card is up,
    // re-anchor it in the new space (PluginUpdateHint's zoom watch).
    watch(dpiScale, () => {
      if (open.value) place();
    });
    onBeforeUnmount(() => {
      clearTimers();
      window.removeEventListener("resize", onResize);
    });

    return () => (
      <span
        {...attrs}
        class={["gateway-captcha-hint", attrs.class as string | undefined]}
        ref={wrapEl}
        onMouseenter={onEnter}
        onMouseleave={onLeave}
      >
        {slots.default?.()}
        {open.value ? (
          <Teleport to="body">
            <div
              class="gateway-captcha-hint__pop"
              ref={popEl}
              style={popStyle.value ?? undefined}
              role={pinned.value ? "status" : "tooltip"}
              onMouseenter={() => {
                hoverPop.value = true;
                clearTimers();
              }}
              onMouseleave={() => {
                hoverPop.value = false;
                onLeave();
              }}
            >
              <button
                type="button"
                class="gateway-captcha-hint__min"
                aria-label={t("gateway.captchaMinimize")}
                data-hint={t("gateway.captchaMinimize")}
                onClick={minimize}
              >
                <Minus size={12} />
              </button>
              <p class="gateway-captcha-hint__title">
                <ShieldCheck size={13} class="gateway-captcha-hint__title-icon" />
                {t("gateway.captchaTitle")}
              </p>
              <p class="gateway-captcha-hint__hint">{t("gateway.captchaHint")}</p>
              {healthError.value ? (
                <p class="gateway-captcha-hint__warn">
                  <AlertTriangle size={13} class="gateway-captcha-hint__warn-icon" />
                  {tError(healthError.value)}
                </p>
              ) : siteKey.value === null ? (
                <p class="gateway-captcha-hint__loading">
                  <HkSpinner size="xs" tone="current" />
                  {t("gateway.captchaLoading")}
                </p>
              ) : (
                <HkCaptchaWidget
                  siteKey={siteKey.value}
                  attempt={attempt.value}
                  onVerify={onVerify}
                />
              )}
              {exchanging.value ? (
                <p class="gateway-captcha-hint__loading">
                  <HkSpinner size="xs" tone="current" />
                  {t("gateway.captchaExchanging")}
                </p>
              ) : null}
              {exchangeError.value ? (
                <p class="gateway-captcha-hint__warn">
                  <AlertTriangle size={13} class="gateway-captcha-hint__warn-icon" />
                  {tError(exchangeError.value)}
                </p>
              ) : null}
            </div>
          </Teleport>
        ) : null}
      </span>
    );
  },
});
