import { defineComponent, onBeforeUnmount, ref } from "vue";
import { ArrowUp } from "lucide-vue-next";

import "./SScrollTop.scss";

/**
 * Floating "back to top" button. Appears when the scroll container is scrolled
 * past a threshold; click smoothly scrolls back to top. Tracks a parent scroll
 * container (passed as a CSS selector or the main content area by default).
 *
 * Position: fixed to the bottom-right, above any bottom bars. Uses the
 * --z-floating token so it stays above content but below modals/toasts.
 */
export default defineComponent({
  name: "SScrollTop",
  props: {
    /** CSS selector for the scroll container to monitor + scroll. Defaults to
     *  the app shell's main content area (.app-shell__main). */
    container: { type: String, default: ".app-shell__main" },
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
          <button
            class="s-scroll-top"
            onClick={scrollToTop}
            aria-label="Back to top"
          >
            <ArrowUp size={20} />
          </button>
        ) : null}
      </Transition>
    );
  },
});
