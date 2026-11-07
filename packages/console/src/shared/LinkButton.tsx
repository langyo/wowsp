/**
 * LinkButton — an `<a>` styled with hikari's own button classes
 * (`hk-btn hk-btn-<variant> hk-btn-<size>`). HkButton renders a real
 * `<button>`, but download targets must stay anchors (a click opens the
 * archive rather than submitting a form); carrying the hk-btn classes
 * keeps the exact hikari look without forking the styles. Port of the
 * website's components/ui/LinkButton for the console's shared surface.
 */
import { computed, defineComponent, type PropType } from "vue";

export default defineComponent({
  name: "LinkButton",
  props: {
    href: { type: String, required: true },
    variant: {
      type: String as PropType<"primary" | "secondary" | "ghost" | "danger" | "outline">,
      default: "primary",
    },
    size: { type: String as PropType<"sm" | "md" | "lg">, default: "md" },
    external: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const cls = computed(() => [
      "hk-btn",
      `hk-btn-${props.variant}`,
      `hk-btn-${props.size}`,
    ]);
    return () => (
      <a
        class={cls.value}
        href={props.href}
        target={props.external ? "_blank" : undefined}
        rel={props.external ? "noopener noreferrer" : undefined}
      >
        {slots.default?.()}
      </a>
    );
  },
});
