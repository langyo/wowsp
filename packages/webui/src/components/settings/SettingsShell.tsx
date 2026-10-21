import { defineComponent, Fragment, nextTick, ref, watch, type PropType } from "vue";

import { HkScrollContainer, type HkSettingsSection } from "@celestia-island/hikari";

import { useSelectionEdgeHint } from "@/composables/useSelectionEdgeHint";

// The rail+pane anatomy and its stylesheet are hikari's settings-window
// grammar; the grouped rail is a wowsp-local extension (the upstream
// HkSettingsBody has no group concept yet), so the shipped component
// style comes in through its sanctioned granular subpath and this shell
// reuses its BEM classes — only the cluster heading styles are local.
import "@celestia-island/hikari/components/HkSettingsDialog.scss";
import "./SettingsShell.scss";

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
 * Both scrollers are hikari HkScrollContainers (the app-wide overlay
 * scrollbar contract): the hosts keep the shell geometry (rail width,
 * pane flex, the modal host's flush-edge trick), the viewports scroll –
 * native bars hidden, the auto-hiding overlay chrome drawn by the
 * library. The rail+pane BEM classes stay on the hosts so every shell
 * selector (here, the modal's and the page's) keeps working unchanged.
 *
 * The rail carries a selection edge hint (useSelectionEdgeHint): with a
 * long grouped section list, an active section scrolled out of the
 * rail's band lights a primary-color gradient at the edge it lies
 * beyond, so "where did the selection go" never hides behind the fold.
 */
/** Consumed slice of HkScrollContainer's exposed component ref (the ref
 *  yields the exposed handle, not an element — see the pane below). */
interface PaneScrollHandle {
  scrollTo(top: number, behavior?: ScrollBehavior): void;
}

/** Same idea for the rail: the selection hint composable senses through
 *  the exposed scroller element (the container's viewport). */
interface RailScrollHandle {
  getScrollElement(): HTMLElement | undefined;
}

export const SettingsShell = defineComponent({
  name: "SettingsShell",
  props: {
    /** Rail clusters, in rail order. */
    groups: { type: Array as PropType<SettingsRailGroup[]>, required: true },
    /** Active section key (v-model:section). Unbound = internal state. */
    section: { type: String, default: undefined },
    /** Accessible name for the rail navigation. */
    navLabel: { type: String, default: undefined },
  },
  emits: {
    "update:section": (key: string) => typeof key === "string",
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
      entries().some((s) => s.key === internal.value) ? internal.value : firstEnabled();

    const paneRef = ref<PaneScrollHandle | null>(null);
    // Section switches restart the pane from the top.
    watch(active, () => {
      void nextTick(() => paneRef.value?.scrollTo(0));
    });

    // Selection edge hint on the rail: an active section scrolled out of
    // the rail's visible band lights a primary gradient at the offending
    // edge (the state binds onto the container ROOT through fallthrough
    // attrs — the positioned non-scrolling box the gradient paints on).
    // App-local twin of hikari's upstream selectionHint prop; retires
    // when a published hikari ships it (see the composable).
    const railRef = ref<RailScrollHandle | null>(null);
    const railBeyond = useSelectionEdgeHint(() => railRef.value?.getScrollElement() ?? null);

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
          data-selection-beyond={railBeyond.value}
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
