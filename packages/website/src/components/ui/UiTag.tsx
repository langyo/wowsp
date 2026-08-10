import { defineComponent, type PropType } from "vue";
import "./UiTag.scss";

export type UiTagTone = "primary" | "success" | "gold" | "neutral" | "error";

/** UiTag — small status pill (version badges, compat states, categories). */
export default defineComponent({
  name: "UiTag",
  props: {
    tone: { type: String as PropType<UiTagTone>, default: "neutral" },
  },
  setup(props, { slots }) {
    return () => <span class={`ui-tag ui-tag--${props.tone}`}>{slots.default?.()}</span>;
  },
});
