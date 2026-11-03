import { defineComponent, onBeforeUnmount, ref, Transition } from "vue";

import { HkFab } from "@celestia-island/hikari";

import { t } from "@/i18n";

/**
 * Floating "back to top" button. Appears when the scroll container is scrolled
 * past a threshold; click smoothly scrolls back to top. Tracks a parent scroll
 * container (passed as a CSS selector or the main content area by default).
 *
 * The scroll listening and visibility stay host-side (HkFab has no scroll
 * logic); the button itself is hikari's glass HkFab — fixed to the
 * bottom-right, sized sm, with the library's own z band (var(--hk-z-fab)).
 */
export default defineComponent({
  name: "SScrollTop",
  props: {
    /** CSS selector for the scroll container to monitor + scroll. Defaults to
     *  the app shell's hikari scroll viewport (the main content area). */
    container: { type: String, default: ".app-shell__scroll .hk-scroll-container-viewport" },
    /** Scroll threshold (px) past which the button appears. */
    threshold: { type: Number, default: 400 },
  },
  setup(props) {
    const visible = ref(false);
    let el: HTMLElement | null = null;

    function onScroll() {
      if (!el) return;
      visible.value = el.scrollTop > props.threshold;
    }

    function scrollToTop() {
      el?.scrollTo({ top: 0, behavior: "smooth" });
    }

    // Defer container lookup to next tick after mount so the DOM is ready.
    function attach() {
      el = document.querySelector(props.container);
      if (el) el.addEventListener("scroll", onScroll, { passive: true });
    }

    // Use a brief timeout to ensure the view has rendered.
    const timer = setTimeout(attach, 100);

    onBeforeUnmount(() => {
      clearTimeout(timer);
      if (el) el.removeEventListener("scroll", onScroll);
    });

    return () => (
      <Transition name="s-fade">
        {visible.value ? (
          <HkFab
            positioning="fixed"
            size="sm"
            variant="glass"
            icon="ArrowUp"
            ariaLabel={t("common.backToTop")}
            onClick={scrollToTop}
          />
        ) : null}
      </Transition>
    );
  },
});
