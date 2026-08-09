/**
 * Search input built on SInput with a dropdown candidate list (modal-style
 * popover). Typing filters a candidate set; picking one emits `pick`.
 */
import { defineComponent, ref } from "vue";

import SInput from "./SInput";
import "./SSearchInput.scss";

export interface SearchCandidate {
  value: string;
  label: string;
  sub?: string;
}

export default defineComponent({
  name: "SSearchInput",
  props: {
    modelValue: { type: String, default: "" },
    placeholder: { type: String, default: "" },
    candidates: { type: Array as () => SearchCandidate[], default: () => [] },
    autofocus: { type: Boolean, default: false },
    block: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: string) => true,
    pick: (_value: string) => true,
  },
  setup(props, { emit }) {
    const open = ref(false);

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") open.value = false;
      if (e.key === "ArrowDown" && props.candidates.length > 0) {
        e.preventDefault();
        pick(props.candidates[0].value);
      }
    };

    function pick(value: string) {
      emit("pick", value);
      open.value = false;
    }

    return () => (
      <div class="s-search">
        <SInput
          modelValue={props.modelValue}
          onUpdate:modelValue={(v: string) => {
            emit("update:modelValue", v);
            open.value = true;
          }}
          placeholder={props.placeholder}
          onKeydown={onKeydown}
          block={props.block}
          autofocus={props.autofocus}
        />
        {open.value && props.modelValue.trim() && props.candidates.length > 0 ? (
          <div class="s-search__pop">
            {props.candidates.slice(0, 12).map((c) => (
              <button
                key={c.value}
                class="s-search__cand"
                onMouseDown={(e) => {
                  // mousedown before blur so the click lands
                  e.preventDefault();
                  pick(c.value);
                }}
              >
                <span class="s-search__label">{c.label}</span>
                {c.sub ? <span class="s-search__sub">{c.sub}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
});
