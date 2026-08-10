import { defineComponent } from "vue";
import "./UiRadio.scss";

/**
 * UiRadio — single radio option. Pair several with the same `name`.
 * v-model pattern: parent passes `modelValue` (group value) + `value`;
 * emits update:modelValue with this option's value when picked.
 */
export default defineComponent({
  name: "UiRadio",
  props: {
    modelValue: { type: [String, Number], default: "" },
    value: { type: [String, Number], required: true },
    name: { type: String, default: "ui-radio" },
    label: { type: String, default: undefined },
    disabled: { type: Boolean, default: false },
  },
  emits: { "update:modelValue": (_v: string | number) => true },
  setup(props, { emit, slots }) {
    return () => {
      const checked = props.modelValue === props.value;
      return (
        <label class={["ui-radio", props.disabled ? "is-disabled" : ""].join(" ")}>
          <span class="ui-radio__dot" data-checked={checked ? "" : undefined}>
            <input
              class="ui-radio__input"
              type="radio"
              name={props.name}
              checked={checked}
              disabled={props.disabled}
              onChange={() => emit("update:modelValue", props.value)}
            />
            <span class="ui-radio__inner" />
          </span>
          {props.label || slots.default ? (
            <span class="ui-radio__label">{slots.default?.() ?? props.label}</span>
          ) : null}
        </label>
      );
    };
  },
});
