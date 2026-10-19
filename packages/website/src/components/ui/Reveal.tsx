import { defineComponent, h, type VNodeRef } from "vue";
import { useScrollReveal } from "@/composables/useScrollReveal";

/**
 * Reveal — wraps content in a scroll-triggered fade/rise (theme.scss `.reveal`).
 * `<Reveal delay={120}>…</Reveal>` — one observer per instance.
 */
export default defineComponent({
  name: "Reveal",
  props: {
    delay: { type: Number, default: 0 },
    tag: { type: String, default: "div" },
  },
  setup(props, { slots }) {
    const r = useScrollReveal(props.delay);
    // Dynamic tag (string prop): h() takes any tag name while keeping the
    // ref/attr types, no escape hatch needed.
    const setRef: VNodeRef = (el) => r.setEl(el instanceof HTMLElement ? el : null);
    return () =>
      h(
        props.tag,
        {
          ref: setRef,
          class: r.cls(),
          style: r.style(),
        },
        slots.default?.(),
      );
  },
});
