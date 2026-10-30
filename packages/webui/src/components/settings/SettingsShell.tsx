import {
  defineComponent,
  Fragment,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type PropType,
} from "vue";

import {
  HkScrollContainer,
  type HkSettingsSection,
} from "@celestia-island/hikari";

// The rail+pane anatomy and its stylesheet are hikari's settings-window
// grammar; the grouped rail is a wowsp-local extension (the upstream
// HkSettingsBody has no group concept yet), so the shipped component
// style comes in through its sanctioned granular subpath and this shell
// reuses its BEM classes — only the cluster heading styles are local.
import "@celestia-island/hikari/components/HkSettingsDialog.scss";
import "./SettingsShell.scss";

/** How long a focus glide keeps retargeting while the section's async
 *  rows settle (see glideToAnchor). Generous on purpose: the glide must
 *  outlast the RPC burst a section open triggers, but stay bounded so a
 *  chatty section can never pin the pane. */
const GLIDE_SETTLE_MS = 3000;

/** One titled rail cluster (first level) and its nav entries (second
 *  level) — the grouped variant of a HkSettingsSection rail. */
export interface SettingsRailGroup {
  /** Group identity, also the render key. */
  key: string;
  /** Small caps title drawn above the cluster. */
  label: string;
  /** Member entries, in rail order. */
  sections: HkSettingsSection[];
}

/**
 * SettingsShell — wowsp's grouped take on hikari's HkSettingsBody: the
 * same rail+pane anatomy and behavior contract (v-model:section, pane is
 * the only scroller, section switches restart it from the top), but the
 * rail renders small-caps group titles between entry clusters so a long
 * flat section list reads as a few named groups.
 *
 * Behavior mirrors the upstream body one-to-one (controlled/unbound
 * section state, immediate watch so a deep-linked opening section wins
 * over the first entry, disabled entries render but cannot activate) so
 * swapping this in for HkSettingsBody changes nothing but the rail's
 * grouping.
 *
 * Two opening affordances ride on the switch-restart contract: a
 * one-shot `focusAnchor` glides the pane onto a requested card instead
 * of restarting at the top (see the prop), and every section landing
 * brings the rail's selected entry into view — centered when it fits,
 * clamped at either end — so a deep-linked opener ten entries down the
 * list is actually in sight, not just highlighted off-screen.
 *
 * Both scrollers are hikari HkScrollContainers (the app-wide overlay
 * scrollbar contract): the hosts keep the shell geometry (rail width,
 * pane flex, the modal host's flush-edge trick), the viewports scroll –
 * native bars hidden, the auto-hiding overlay chrome drawn by the
 * library. The rail+pane BEM classes stay on the hosts so every shell
 * selector (here, the modal's and the page's) keeps working unchanged.
 *
 * The rail carries hikari's own selectionHint prop (adopted from the
 * app-local twin once 0.55.229 shipped it upstream): with a long grouped
 * section list, an active section scrolled out of the rail's band lights
 * a primary-color gradient at the edge it lies beyond, so "where did the
 * selection go" never hides behind the fold — painter and feather
 * contract live in the library.
 */
/** Consumed slice of HkScrollContainer's exposed component ref (the ref
 *  yields the exposed handle, not an element — see the scrollers below). */
interface ScrollHandle {
  scrollTo(top: number, behavior?: ScrollBehavior): void;
  getScrollElement(): HTMLElement | undefined;
}

export const SettingsShell = defineComponent({
  name: "SettingsShell",
  props: {
    /** Rail clusters, in rail order. */
    groups: { type: Array as PropType<SettingsRailGroup[]>, required: true },
    /** Active section key (v-model:section). Unbound = internal state. */
    section: { type: String, default: undefined },
    /** One-shot card glide: when set, the active section's pane glides
     *  onto the card carrying `data-settings-anchor=<value>` (smooth —
     *  the slide is the affordance) instead of restarting at the top,
     *  then immediately reports `update:focusAnchor` = null so a stored
     *  request never replays on a later open. */
    focusAnchor: { type: String, default: undefined },
    /** Accessible name for the rail navigation. */
    navLabel: { type: String, default: undefined },
  },
  emits: {
    "update:section": (key: string) => typeof key === "string",
    "update:focusAnchor": (anchor: string | null) =>
      anchor === null || typeof anchor === "string",
  },
  setup(props, { emit, slots }) {
    const entries = () => props.groups.flatMap((group) => group.sections);
    const firstEnabled = () => entries().find((s) => !s.disabled)?.key ?? "";

    const internal = ref(firstEnabled());
    // Controlled while a section prop is bound: external changes flow in,
    // clicks flow out. Immediate so an opener that mounts ALREADY on a
    // deep-linked section wins over the first-entry default — and a
    // disabled (or unknown) key never activates; the first usable entry
    // keeps the pane instead.
    watch(
      () => props.section,
      (key) => {
        if (key == null) return;
        if (entries().some((s) => s.key === key && !s.disabled)) {
          internal.value = key;
        }
      },
      { immediate: true },
    );
    const active = () =>
      entries().some((s) => s.key === internal.value)
        ? internal.value
        : firstEnabled();

    const railRef = ref<ScrollHandle | null>(null);
    const paneRef = ref<ScrollHandle | null>(null);

    // --- rail: the selected entry stays in view --------------------------

    /** Center the active entry in the rail's own viewport, clamped at
     *  either end. Only the rail viewport ever moves: a raw
     *  `scrollIntoView({ block: "center" })` would drag every
     *  scrollable ancestor along (the whole settings PAGE on phone
     *  layout), while this scrolls exactly one box. The deltas are
     *  divided by the viewport's drawn/laid size ratio because
     *  scrollTop takes laid-out units while rects report drawn ones —
     *  a DPI-zoomed root (theme/dpiPrefs) would otherwise overshoot by
     *  (scale - 1) of the distance. Dual-axis for the day the rail ever
     *  scrolls horizontally (today's phone rail is a vertical icon
     *  strip — the inline axis just clamps to a no-op). */
    function centerActiveRailItem() {
      void nextTick(() => {
        const vp = railRef.value?.getScrollElement();
        const el = vp?.querySelector<HTMLElement>(
          ".hk-settings__rail-item.is-active",
        );
        if (!vp || !el) return;
        const vpRect = vp.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const scaleX = vp.offsetWidth > 0 ? vpRect.width / vp.offsetWidth : 1;
        const scaleY =
          vp.offsetHeight > 0 ? vpRect.height / vp.offsetHeight : 1;
        const clamp = (v: number, max: number) =>
          Math.min(Math.max(v, 0), Math.max(max, 0));
        vp.scrollTo({
          top: clamp(
            vp.scrollTop +
              (elRect.top -
                (vpRect.top + (vpRect.height - elRect.height) / 2)) /
                scaleY,
            vp.scrollHeight - vp.clientHeight,
          ),
          left: clamp(
            vp.scrollLeft +
              (elRect.left -
                (vpRect.left + (vpRect.width - elRect.width) / 2)) /
                scaleX,
            vp.scrollWidth - vp.clientWidth,
          ),
        });
      });
    }

    // --- pane: an opener may glide onto one card -------------------------

    /** The card currently rendered in the pane that carries
     *  `data-settings-anchor` (dataset comparison, so anchor values stay
     *  free-form — no selector escaping to get right). */
    function findAnchorCard(
      vp: HTMLElement | undefined,
      anchor: string,
    ): HTMLElement | null {
      const cards = vp?.querySelectorAll<HTMLElement>("[data-settings-anchor]");
      return cards
        ? (Array.from(cards).find((c) => c.dataset.settingsAnchor === anchor) ??
            null)
        : null;
    }

    /** Glide onto the anchor card with native scrollIntoView, because
     *  WHICH box must scroll depends on the host: the modal's pane
     *  scrolls itself, while the /settings page grows the pane with its
     *  content (SettingsView.scss) and the app shell's page scroller
     *  owns the scroll. scrollIntoView moves every scrollable ancestor
     *  that needs it, engine-side — so DPI zoom needs no manual math
     *  here (unlike the rail centering above, which scrolls one exact
     *  box). */
    function glideOnto(el: HTMLElement) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    /** The glide currently requested (queued or live); null when idle. */
    let glideAnchor: string | null = null;
    /** Retarget bookkeeping for the live glide; null until it starts. */
    let glideTeardown: (() => void) | null = null;

    function stopGlide() {
      glideAnchor = null;
      glideTeardown?.();
      glideTeardown = null;
    }

    /** Glide the pane onto the card carrying `data-settings-anchor`.
     *  Openers land the user on a section whose interesting card sits
     *  below the fold, so the glide is smooth — the slide is the point.
     *  It also stays honest while the section settles: a fresh-opened
     *  section's RPC-fed rows resize the cards for a moment (the rows
     *  above the target grow), so the glide retargets on content
     *  resizes — and hands the scroll back the instant the user scrolls
     *  for themselves, bounded by GLIDE_SETTLE_MS. */
    function glideToAnchor(anchor: string) {
      if (glideAnchor === anchor) {
        // Same request again while it is still live: nothing to redo,
        // but the request is consumed either way.
        emit("update:focusAnchor", null);
        return;
      }
      stopGlide();
      glideAnchor = anchor;
      void nextTick(() => {
        if (glideAnchor !== anchor) return; // superseded while queued
        const handle = paneRef.value;
        const vp = handle?.getScrollElement();
        const el = findAnchorCard(vp, anchor);
        if (!handle || !vp || !el) {
          // Unknown anchor (it belongs to another section, or the build
          // clamped the landing away): behave like a plain section
          // switch rather than stranding the pane mid-scroll.
          glideAnchor = null;
          handle?.scrollTo(0);
          emit("update:focusAnchor", null);
          return;
        }
        glideOnto(el);
        emit("update:focusAnchor", null);

        // Retarget while the cards settle: observing the viewport's flow
        // children covers every card (the section's async rows grow
        // them); the glide is the same target, so a retarget mid-flight
        // just re-aims the ongoing smooth scroll.
        const ro = new ResizeObserver(() => {
          glideOnto(el);
        });
        for (const child of Array.from(vp.children)) {
          if (child instanceof HTMLElement) ro.observe(child);
        }
        // User input anywhere ends the glide at once — the retarget must
        // never fight the person holding the wheel. Window-level capture,
        // because which box scrolls depends on the host: on the /settings
        // page the app shell's page scroller moves, and input aimed at
        // the rail or the sticky bar never passes through the pane
        // viewport the pane-scoped listeners would sit on.
        const yields: Array<[string, () => void]> = [
          ["wheel", stopGlide],
          ["pointerdown", stopGlide],
          ["touchstart", stopGlide],
          ["keydown", stopGlide],
        ];
        for (const [type, fn] of yields) {
          window.addEventListener(type, fn, { passive: true, capture: true });
        }
        const timer = window.setTimeout(stopGlide, GLIDE_SETTLE_MS);
        glideTeardown = () => {
          ro.disconnect();
          window.clearTimeout(timer);
          for (const [type, fn] of yields) {
            window.removeEventListener(type, fn, { capture: true });
          }
        };
      });
    }

    /** What the pane does when a section lands: honor a pending focus
     *  glide, else restart from the top (the switch contract). */
    function settlePane() {
      const anchor = props.focusAnchor;
      if (anchor) {
        glideToAnchor(anchor);
      } else {
        stopGlide();
        void nextTick(() => paneRef.value?.scrollTo(0));
      }
    }

    // Section landings settle the pane and bring the rail's selected
    // entry into view.
    watch(active, () => {
      settlePane();
      centerActiveRailItem();
    });
    // Neither runs for the state a deep-linked opener arrives with (the
    // section is set before this shell mounts), so the opening landing
    // gets one explicit pass of its own.
    onMounted(() => {
      settlePane();
      centerActiveRailItem();
    });
    // An anchor can also arrive while its section is already showing
    // (settingsUi.show() with the modal open): the section never changes
    // there, so the request needs its own way in.
    watch(
      () => props.focusAnchor,
      (anchor) => {
        if (anchor) settlePane();
      },
    );
    onBeforeUnmount(stopGlide);

    function pick(key: string) {
      const entry = entries().find((s) => s.key === key);
      if (!entry || entry.disabled) return;
      internal.value = key;
      emit("update:section", key);
    }

    return () => (
      <div class="hk-settings">
        <HkScrollContainer
          as="nav"
          class="hk-settings__rail"
          ref={railRef}
          selectionHint
          aria-label={props.navLabel}
        >
          {props.groups.map((group) => (
            <Fragment key={group.key}>
              <div class="hk-settings__rail-heading">{group.label}</div>
              {group.sections.map((s) => {
                const Icon = s.icon;
                const on = active() === s.key && !s.disabled;
                // Overflow-gated hint (see composables/globalTooltip):
                // long locale labels ellipsize in the narrow rail — the
                // popup only fires when the label actually clips.
                return (
                  <button
                    key={s.key}
                    type="button"
                    class={["hk-settings__rail-item", on ? "is-active" : ""]}
                    aria-current={on ? "true" : undefined}
                    aria-disabled={s.disabled || undefined}
                    disabled={s.disabled}
                    data-hint-overflow={s.label}
                    data-hint-pos="right"
                    onClick={() => pick(s.key)}
                  >
                    {typeof Icon === "function" ? (
                      <span class="hk-settings__rail-icon" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                    ) : null}
                    <span class="hk-settings__rail-label">{s.label}</span>
                  </button>
                );
              })}
            </Fragment>
          ))}
        </HkScrollContainer>
        <HkScrollContainer class="hk-settings__pane" ref={paneRef}>
          {slots[active()]?.()}
        </HkScrollContainer>
      </div>
    );
  },
});

export default SettingsShell;
