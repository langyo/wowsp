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
    return () => {
      // Dynamic tag (string prop): the JSX intrinsic table has no index
      // signature for it, so route through "any".
      const Tag = props.tag as any;
      return (
        <Tag
          ref={(el: Element | null) => r.setEl(el instanceof HTMLElement ? el : null)}
          class={r.cls()}
          style={r.style()}
        >
          {slots.default?.()}
        </Tag>
      );
    };
  },
});
