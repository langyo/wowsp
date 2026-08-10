import { defineComponent } from "vue";
import { Check } from "lucide-vue-next";
import "./UiCheckbox.scss";

/**
 * UiCheckbox — soft-rounded box with a springing check glyph.
 * v-model:boolean. Label via `label` prop or default slot.
 */
export default defineComponent({
  name: "UiCheckbox",
  props: {
    modelValue: { type: Boolean, default: false },
    label: { type: String, default: undefined },
    disabled: { type: Boolean, default: false },
  },
  emits: { "update:modelValue": (_v: boolean) => true },
  setup(props, { emit, slots }) {
    function onChange(e: Event) {
      emit("update:modelValue", (e.target as HTMLInputElement).checked);
    }
    return () => (
      <label class={["ui-check", props.disabled ? "is-disabled" : ""].join(" ")}>
        <span class="ui-check__box" data-checked={props.modelValue ? "" : undefined}>
          <input
            class="ui-check__input"
            type="checkbox"
            checked={props.modelValue}
            disabled={props.disabled}
            onChange={onChange}
          />
          <Check size={13} stroke-width={3.2} class="ui-check__glyph" />
        </span>
        {props.label || slots.default ? (
          <span class="ui-check__label">{slots.default?.() ?? props.label}</span>
        ) : null}
      </label>
    );
  },
});
