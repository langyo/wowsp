import { defineComponent, type PropType } from "vue";
import { Check } from "lucide-vue-next";

import "./SCheckbox.scss";

export type CheckType = "checkbox" | "radio";

/**
 * Checkbox / radio / switch control. Ported from shittim-chest's SCheckbox,
 * simplified to remove the animation-bus dependency (WoWSP doesn't use a
 * shared rAF bus). `type` distinguishes checkbox vs radio; `variant` switches
 * the presentation between a box (checkbox/radio) and a pill toggle (switch) —
 * a switch is just a checkbox drawn differently, so both share the same
 * modelValue contract. Label via `label` prop or default slot.
 */
export default defineComponent({
  name: "SCheckbox",
  props: {
    modelValue: { type: Boolean, default: false },
    label: { type: String, default: undefined },
    disabled: { type: Boolean, default: false },
    type: { type: String as PropType<CheckType>, default: "checkbox" },
    /** "checkbox" = box (or radio dot); "switch" = pill toggle. */
    variant: { type: String as PropType<"checkbox" | "switch">, default: "checkbox" },
  },
  emits: {
    "update:modelValue": (_value: boolean) => true,
    click: (_e: MouseEvent) => true,
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
        data-variant={props.variant}
        data-disabled={props.disabled ? "" : undefined}
        onClick={(e) => emit("click", e)}
      >
        {props.variant === "switch" ? (
          <span class="s-checkbox-switch" data-checked={props.modelValue ? "" : undefined}>
            <input
              class="s-checkbox-input"
              type="checkbox"
              checked={props.modelValue}
              disabled={props.disabled}
              onChange={onChange}
            />
            <span data-el="thumb" />
          </span>
        ) : (
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
        )}
        {props.label || slots.default ? (
          <span data-el="label">
            {slots.default?.() ?? props.label}
          </span>
        ) : null}
      </label>
    );
  },
});
