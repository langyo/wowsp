import { computed, defineComponent, onBeforeUnmount, onMounted, ref, type PropType } from "vue";
import { ChevronDown, Check } from "lucide-vue-next";

import "./SSelect.scss";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * WoWSP design-system select dropdown. Replaces the native <select> with a
 * themed, keyboard-navigable dropdown that matches the app's dark/light
 * tokens. Uses a portal-less absolute-positioned panel (no <Teleport> needed
 * since it's within the app container).
 *
 * Usage (JSX):
 *   <SSelect
 *     modelValue={realm.value}
 *     onUpdate:modelValue={(v) => (realm.value = v)}
 *     options={[{ value: "asia", label: "ASIA" }, ...]}
 *   />
 */
export default defineComponent({
  name: "SSelect",
  props: {
    modelValue: { type: String, required: true },
    options: { type: Array as PropType<SelectOption[]>, required: true },
    size: { type: String as PropType<"sm" | "md">, default: "md" },
    block: { type: Boolean, default: false },
    placeholder: { type: String, default: undefined },
  },
  emits: {
    "update:modelValue": (_v: string) => true,
  },
  setup(props, { emit }) {
    const open = ref(false);
    const rootRef = ref<HTMLElement | null>(null);
    const highlightedIndex = ref(0);

    const selectedLabel = computed(() => {
      const opt = props.options.find((o) => o.value === props.modelValue);
      return opt?.label ?? props.placeholder ?? props.modelValue;
    });

    function toggle() {
      open.value = !open.value;
      if (open.value) {
        highlightedIndex.value = Math.max(
          0,
          props.options.findIndex((o) => o.value === props.modelValue),
        );
      }
    }

    function select(value: string) {
      emit("update:modelValue", value);
      open.value = false;
    }

    function onKeydown(e: KeyboardEvent) {
      if (!open.value) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
        return;
      }
      if (e.key === "Escape") {
        open.value = false;
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightedIndex.value = Math.min(props.options.length - 1, highlightedIndex.value + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightedIndex.value = Math.max(0, highlightedIndex.value - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = props.options[highlightedIndex.value];
        if (opt) select(opt.value);
      }
    }

    function onDocClick(e: MouseEvent) {
      if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
        open.value = false;
      }
    }

    onMounted(() => document.addEventListener("mousedown", onDocClick));
    onBeforeUnmount(() => document.removeEventListener("mousedown", onDocClick));

    return () => (
      <div
        ref={rootRef}
        class={["s-select", `s-select-${props.size}`, props.block ? "s-select-block" : ""]}
        tabindex="0"
        onKeydown={onKeydown}
      >
        <button
          type="button"
          class={["s-select__trigger", open.value ? "s-select__trigger--open" : ""]}
          onClick={toggle}
        >
          <span class="s-select__value">{selectedLabel.value}</span>
          <ChevronDown size={14} class="s-select__chevron" />
        </button>
        {open.value ? (
          <ul class="s-select__panel" role="listbox">
            {props.options.map((opt, i) => (
              <li
                role="option"
                class={[
                  "s-select__option",
                  i === highlightedIndex.value ? "s-select__option--hl" : "",
                  opt.value === props.modelValue ? "s-select__option--sel" : "",
                ]}
                onClick={() => select(opt.value)}
                onMouseenter={() => (highlightedIndex.value = i)}
              >
                <span>{opt.label}</span>
                {opt.value === props.modelValue ? <Check size={13} class="s-select__check" /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  },
});
