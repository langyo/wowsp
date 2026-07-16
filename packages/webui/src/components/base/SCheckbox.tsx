import { defineComponent, type PropType } from "vue";
import { Check } from "lucide-vue-next";

import "./SCheckbox.scss";

export type CheckType = "checkbox" | "radio";

/**
 * Checkbox / radio control. Ported from shittim-chest's SCheckbox, simplified
 * to remove the animation-bus dependency (WoWSP doesn't use a shared rAF bus).
 * Supports both checkbox and radio via the `type` prop. Label via `label`
 * prop or default slot.
 */
export default defineComponent({
  name: "SCheckbox",
  props: {
    modelValue: { type: Boolean, default: false },
    label: { type: String, default: undefined },
    disabled: { type: Boolean, default: false },
    type: { type: String as PropType<CheckType>, default: "checkbox" },
  },
  emits: {
    "update:modelValue": (_value: boolean) => true,
  },
  setup(props, { emit, slots }) {
    function onChange(e: Event) {
      emit("update:modelValue", (e.target as HTMLInputElement).checked);
    }

    const dataType = props.type === "radio" ? "radio" : "checkbox";

    return () => (
      <label
        class="s-checkbox"
        data-type={dataType}
        data-disabled={props.disabled ? "" : undefined}
      >
        <span class="s-checkbox-box" data-checked={props.modelValue ? "" : undefined}>
          <input
            class="s-checkbox-input"
            type={dataType}
            checked={props.modelValue}
            disabled={props.disabled}
            onChange={onChange}
          />
          {props.modelValue
            ? props.type === "radio"
              ? <span data-el="dot" />
              : <Check size={14} data-el="icon" />
            : null}
        </span>
        {props.label || slots.default ? (
          <span data-el="label">
            {slots.default?.() ?? props.label}
          </span>
        ) : null}
      </label>
    );
  },
});
