import { defineComponent, type PropType } from "vue";
import "./UiInput.scss";

/**
 * UiInput — frosted text field. v-model:string.
 * Optional label above, hint (or error) below.
 */
export default defineComponent({
  name: "UiInput",
  props: {
    modelValue: { type: String, default: "" },
    type: { type: String as PropType<"text" | "search" | "url" | "number">, default: "text" },
    label: { type: String, default: undefined },
    placeholder: { type: String, default: "" },
    hint: { type: String, default: undefined },
    error: { type: String, default: undefined },
    disabled: { type: Boolean, default: false },
  },
  emits: { "update:modelValue": (_v: string) => true },
  setup(props, { emit }) {
    function onInput(e: Event) {
      emit("update:modelValue", (e.target as HTMLInputElement).value);
    }
    return () => (
      <label class={["ui-field", props.disabled ? "is-disabled" : "", props.error ? "has-error" : ""].join(" ")}>
        {props.label ? <span class="ui-field__label">{props.label}</span> : null}
        <input
          class="ui-field__input"
          type={props.type}
          value={props.modelValue}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onInput={onInput}
        />
        {props.error ? (
          <span class="ui-field__hint ui-field__hint--error">{props.error}</span>
        ) : props.hint ? (
          <span class="ui-field__hint">{props.hint}</span>
        ) : null}
      </label>
    );
  },
});
