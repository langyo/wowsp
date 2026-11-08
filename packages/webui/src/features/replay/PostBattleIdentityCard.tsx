/**
 * Host + rich hover card for a post-battle row's complete identity (the
 * replay 结果 / 战后统计 matrix).
 *
 * The rows themselves can only ellipsize their identity: the compact line is
 * a single track, the full card's tracks are fixed, and since the
 * 2026-11-08 review every multi-character seal collapses behind the small
 * "!" badge instead of overflowing the nickname. This card is where the
 * whole identity survives on hover — the same lines the list rows read,
 * dressed in the hovering row's own density classes (`density`):
 *
 *   1. the marker-tinted (markerTintClass) masked nickname, the "[clanTag]"
 *      in the row clan ink and the bot marker for AI rows;
 *   2. every identity tag the row carries, as the real faces the list
 *      presses: the yellow DivisionTag, the local marker's name (the nick
 *      tint alone does not say WHICH mark) and EVERY seal as the real
 *      StampTag chips — the collapsed multi-character ones included;
 *   3. the ship tier + name on the row's sub-line classes.
 *
 * The host element is the row's own hover target: compact rows pass their
 * whole drill-down button (`as="button"`), the full card passes its identity
 * stack (`as="span"`, inside the card button) — so the card never widens the
 * hover zone over the ship strip's own combat card. It is deliberately
 * pointer-only on hover-capable environments; the row button keeps its
 * click-to-detail behavior untouched (the badge inside it is a plain span,
 * never a nested button).
 *
 * Touch / no-hover fallback: the global data-hint channel is the only hint
 * touch and AT surfaces get, so when matchMedia("(hover: none)") matches the
 * host keeps the panel's plain-text fallback hint (the old rosterRowHint
 * string) as data-hint and this card never renders on that surface — the two
 * channels are deliberately mutually exclusive, never stacked.
 *
 * The card follows the proven Vue-native teleport pattern of LiveShipMeta /
 * MapNameTag: Teleport to <body> + fixed positioning so the scrolling result
 * columns (whose ancestors clip) cannot amputate it, a measured box placed
 * below the anchor and flipped above when the viewport bottom is too close
 * (liveCardPlacement), the root DPI zoom divided out of every measured value,
 * and a plain-tooltip z band. Unlike the plain-DOM global-tooltip channel
 * this can mount real components (StampTag / DivisionTag), which is why the
 * rows use it.
 */
import {
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  ref,
  Teleport,
  type CSSProperties,
  type PropType,
} from "vue";

import { t } from "@/i18n";
import DivisionTag from "@/components/base/DivisionTag";
import StampTag from "@/components/base/StampTag";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import { placeLiveCard } from "./liveCardPlacement";
import type { PostBattleIdentityModel } from "./postBattleIdentity";
import "./PostBattleIdentityCard.scss";

/** Hover-show delay: one beat after the pointer settles on a row (the live
 *  roster strip's cadence), so sweeping across the matrix never strobes
 *  cards. */
const SHOW_DELAY_MS = 220;
/** Leave grace: the pointer can travel from the row onto the card (which
 *  floats a gap below/above it) without the card blinking shut. */
const HIDE_GRACE_MS = 180;
/** Card width — content-driven height, fixed width so a long nickname
 *  ellipsizes instead of stretching the float across the viewport. */
export const POSTBATTLE_ID_CARD_WIDTH_PX = 300;

/** Hover-capability probe, read once per mount (input hardware rarely changes
 *  mid-session): hover-less surfaces keep the plain-text fallback hint, and
 *  the rich card never mounts there — see the module banner. */
function hoverUnavailable(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none)").matches
  );
}

export default defineComponent({
  name: "PostBattleIdentityCard",
  /** The card teleports beside the host — a multi-root render, so Vue would
   *  skip attr fallthrough (with a dev warning per re-render); the caller's
   *  class / data attrs / click handler are merged by hand below. */
  inheritAttrs: false,
  props: {
    /** The host element: the compact row's whole button, or the full card's
     *  identity stack span. */
    as: {
      type: String as PropType<"button" | "span">,
      default: "span",
    },
    /** The density the host lives in — the card dresses its three lines with
     *  that density's row classes so it matches the row it hovers. */
    density: {
      type: String as PropType<"compact" | "full">,
      default: "compact",
    },
    /** The identity the card paints (already masked / localized by the
     *  panel). */
    identity: {
      type: Object as PropType<PostBattleIdentityModel>,
      required: true,
    },
    /** The complete identity as the panel's plain-text rosterRowHint string.
     *  Mounted as the host's data-hint ONLY where hovering is unavailable
     *  (touch / AT), where the global tooltip's bridge is the hint channel;
     *  never alongside the card. */
    fallbackHint: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** The panel's drill-down click (declared as a prop because the host is
     *  built by h() — a bare onClick attr would be an unknown JSX prop). The
     *  host is the row's own button, so clicks keep opening the detail. */
    onClick: {
      type: Function as PropType<(event?: MouseEvent) => void>,
      default: null,
    },
  },
  setup(props, { attrs, slots }) {
    const cardEl = ref<HTMLElement | null>(null);
    const open = ref(false);
    const cardPos = ref<CSSProperties>({});
    // The card teleports to <body> — inside the root DPI zoom's subtree — so
    // its written left/top paint in the zoomed local space while the anchor's
    // gBCR and window.innerWidth/innerHeight answer in root-visual px:
    // placeLiveCard runs entirely in local space, fed the measured values
    // divided by the applied scale (LiveShipMeta's same zoom note;
    // offsetWidth/offsetHeight are already local).
    const dpiScale = useAppliedDpiScale();
    // The hover-less surface keeps the plain-text hint channel instead (see
    // the module banner): both are mutually exclusive, never stacked.
    const noHover = hoverUnavailable();

    let showTimer: number | null = null;
    let hideTimer: number | null = null;
    let inZone = false;
    let inCard = false;

    function clearShowTimer(): void {
      if (showTimer != null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
    }

    function clearHideTimer(): void {
      if (hideTimer != null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    }

    /** Render first (hidden), MEASURE the real box, then place: the card is
     *  content-driven (a variable number of chips), so an estimated height
     *  would float a sparse card in thin air above its row. */
    function show(host: HTMLElement): void {
      if (open.value) return;
      const r = host.getBoundingClientRect();
      // The row can unmount during the arm delay (roster reshuffle, a
      // density flip): a zero rect would clamp the card into a corner — skip
      // and let the next hover re-arm instead.
      if (!r.width && !r.height) return;
      cardPos.value = {
        left: "0px",
        top: "0px",
        width: `${POSTBATTLE_ID_CARD_WIDTH_PX}px`,
        visibility: "hidden",
      };
      open.value = true;
      void nextTick(() => {
        const card = cardEl.value;
        if (!card) return;
        const z = dpiScale.value;
        const { left, top } = placeLiveCard(
          {
            left: r.left / z,
            top: r.top / z,
            right: r.right / z,
            bottom: r.bottom / z,
          },
          POSTBATTLE_ID_CARD_WIDTH_PX,
          card.offsetHeight,
          window.innerWidth / z,
          window.innerHeight / z,
        );
        cardPos.value = {
          left: `${Math.round(left)}px`,
          top: `${Math.round(top)}px`,
          width: `${POSTBATTLE_ID_CARD_WIDTH_PX}px`,
          visibility: "visible",
        };
      });
    }

    function scheduleHide(): void {
      clearHideTimer();
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        if (!inZone && !inCard) open.value = false;
      }, HIDE_GRACE_MS);
    }

    function hideNow(): void {
      inZone = false;
      inCard = false;
      clearShowTimer();
      clearHideTimer();
      open.value = false;
    }

    function armZone(host: HTMLElement): void {
      if (noHover) return;
      inZone = true;
      clearHideTimer();
      clearShowTimer();
      showTimer = window.setTimeout(() => {
        showTimer = null;
        show(host);
      }, SHOW_DELAY_MS);
    }

    function disarmZone(): void {
      inZone = false;
      clearShowTimer();
      scheduleHide();
    }

    function onCardEnter(): void {
      inCard = true;
      clearHideTimer();
    }

    function onCardLeave(): void {
      inCard = false;
      scheduleHide();
    }

    /** A fixed-position card detaches from its anchor on any scroll — close
     *  instead of drifting (LiveShipMeta's same call; the results columns
     *  scroll under a stationary pointer). */
    function onScrollCapture(): void {
      hideNow();
    }

    function onKeydown(e: KeyboardEvent): void {
      if (e.key === "Escape") hideNow();
    }

    document.addEventListener("scroll", onScrollCapture, true);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", hideNow);
    // Window focus loss hides too — parity with the global tooltip, so a
    // card is never the one thing left painted on a minimized app.
    window.addEventListener("blur", hideNow);
    onBeforeUnmount(() => {
      clearShowTimer();
      clearHideTimer();
      document.removeEventListener("scroll", onScrollCapture, true);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("resize", hideNow);
      window.removeEventListener("blur", hideNow);
    });

    return () => {
      const full = props.density === "full";
      // The card keeps the HOVERED row's own classes (not a lookalike
      // restyle): nick / clan / ship line / tier / ship name resolve to the
      // compact or full-card faces so the float matches the row under the
      // pointer in both densities.
      const nickClass = full
        ? "replay-view__postbattle-fcell-nick"
        : "replay-view__postbattle-cell-nick";
      const clanClass = full
        ? "replay-view__postbattle-fcell-clan"
        : "replay-view__postbattle-cell-clan";
      const shipLineClass = full
        ? "replay-view__postbattle-fcell-ship"
        : "replay-view__postbattle-cell-sub";
      const tierClass = full
        ? "replay-view__postbattle-fcell-tier"
        : "replay-view__postbattle-cell-tier";
      const shipClass = full
        ? "replay-view__postbattle-fcell-shipname"
        : "replay-view__postbattle-cell-ship";

      const hostAttrs: Record<string, unknown> = {
        ...attrs,
        class: ["postbattle-idcard-host", attrs.class],
        onMouseenter: (e: MouseEvent) => armZone(e.currentTarget as HTMLElement),
        onMouseleave: disarmZone,
      };
      if (props.as === "button") hostAttrs.type = "button";
      if (props.onClick) hostAttrs.onClick = props.onClick;
      // Hover-less surfaces: the old plain-text hint is the only channel they
      // get (the rich card needs a pointer), so mount it on the host here —
      // never on hover-capable surfaces, where it would stack a second popup
      // under the card.
      if (noHover && props.fallbackHint) hostAttrs["data-hint"] = props.fallbackHint;

      const host = h(
        props.as,
        hostAttrs,
        slots.default ? slots.default() : [],
      );

      const identity = props.identity;
      const card = open.value ? (
        <Teleport to="body">
          <div
            ref={cardEl}
            class={[
              "postbattle-idcard",
              full ? "postbattle-idcard--full" : "postbattle-idcard--compact",
            ]}
            role="tooltip"
            style={cardPos.value}
            onMouseenter={onCardEnter}
            onMouseleave={onCardLeave}
          >
            {/* Line 1: the row's identity presentation — same tint, clan ink
                and bot marker as the row. */}
            <div class="postbattle-idcard__name">
              <span class={["postbattle-idcard__nick", nickClass, identity.tintClass]}>
                {identity.name}
              </span>
              {identity.clanTag ? (
                <span class={[clanClass, "postbattle-idcard__clan"]}>
                  [{identity.clanTag}]
                </span>
              ) : null}
              {identity.ai ? (
                <em class="replay-view__postbattle-bot">{t("replay.bot")}</em>
              ) : null}
            </div>
            {/* Line 2: every tag the row carries, as the real list faces —
                the division tag, the marker's name (the nick tint alone does
                not say which mark) and EVERY seal chip, collapsed ones
                included. */}
            {identity.divisionLetter || identity.markerLabel || identity.seals.length > 0 ? (
              <div class="postbattle-idcard__tags">
                {identity.divisionLetter ? (
                  <DivisionTag letter={identity.divisionLetter} />
                ) : null}
                {identity.markerLabel ? (
                  <span class="postbattle-idcard__marker">{identity.markerLabel}</span>
                ) : null}
                {identity.seals.map((kind) => (
                  <StampTag kind={kind} />
                ))}
              </div>
            ) : null}
            {/* Line 3: tier + ship name on the hovered density's own
                sub-line classes. */}
            <div class={[shipLineClass, "postbattle-idcard__ship"]}>
              <span class={tierClass}>{identity.tier}</span>
              <span class={shipClass}>{identity.shipName}</span>
            </div>
          </div>
        </Teleport>
      ) : null;

      return [host, card];
    };
  },
});
