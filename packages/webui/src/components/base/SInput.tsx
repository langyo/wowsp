/** Generic text input — taller than the compact controls, modest radius. */
import { defineComponent } from "vue";

import "./SInput.scss";

export default defineComponent({
  name: "SInput",
  props: {
    modelValue: { type: String, default: "" },
    placeholder: { type: String, default: "" },
    block: { type: Boolean, default: false },
    autofocus: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: string) => true,
    keydown: (_e: KeyboardEvent) => true,
  },
  setup(props, { emit }) {
    return () => (
      <input
        class={["s-input", props.block ? "s-input--block" : ""]}
        type="text"
        placeholder={props.placeholder}
        value={props.modelValue}
        autofocus={props.autofocus || undefined}
        onInput={(e) => emit("update:modelValue", (e.target as HTMLInputElement).value)}
        onKeydown={(e) => emit("keydown", e)}
      />
    );
  },
});
