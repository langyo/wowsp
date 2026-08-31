/**
 * LinkButton — an `<a>` styled with hikari's own button classes
 * (`hk-btn hk-btn-<variant> hk-btn-<size>`). HButton renders a real
 * `<button>`, but the site's download / GitHub CTAs are external links and
 * must stay anchors; this keeps the exact hikari look without forking the
 * styles.
 */
import { computed, defineComponent } from "vue";

export default defineComponent({
  name: "LinkButton",
  props: {
    href: { type: String, required: true },
    variant: { type: String as () => "primary" | "secondary" | "ghost" | "danger" | "outline", default: "primary" },
    size: { type: String as () => "sm" | "md" | "lg", default: "md" },
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
        rel={props.external ? "noopener" : undefined}
      >
        {slots.default?.()}
      </a>
    );
  },
});
