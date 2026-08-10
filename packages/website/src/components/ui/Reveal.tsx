import { defineComponent } from "vue";
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
    return () => (
      <props.tag ref={r.setEl} class={r.cls()} style={r.style()}>
        {slots.default?.()}
      </props.tag>
    );
  },
});
