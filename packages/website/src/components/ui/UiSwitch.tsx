import { defineComponent } from "vue";
import "./UiSwitch.scss";

/**
 * UiSwitch — pill toggle (iOS-style), the on/off control of the design system.
 * v-model:boolean. Label via `label` prop or default slot.
 */
export default defineComponent({
  name: "UiSwitch",
  props: {
    modelValue: { type: Boolean, default: false },
    label: { type: String, default: undefined },
    disabled: { type: Boolean, default: false },
    ariaLabel: { type: String, default: undefined },
  },
  emits: { "update:modelValue": (_v: boolean) => true },
  setup(props, { emit, slots }) {
    function toggle() {
      if (!props.disabled) emit("update:modelValue", !props.modelValue);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); }
    }
    return () => (
      <label class={["ui-switch", props.disabled ? "is-disabled" : ""].join(" ")}>
        <button
          type="button"
          role="switch"
          aria-checked={props.modelValue}
          aria-label={props.ariaLabel ?? props.label}
          class="ui-switch__track"
          data-checked={props.modelValue ? "" : undefined}
          disabled={props.disabled}
          onClick={toggle}
          onKeydown={onKey}
        >
          <span class="ui-switch__thumb" />
        </button>
        {props.label || slots.default ? (
          <span class="ui-switch__label">{slots.default?.() ?? props.label}</span>
        ) : null}
      </label>
    );
  },
});
