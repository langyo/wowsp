import { defineComponent, onBeforeUnmount, onMounted, ref, Transition, type PropType } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";
import "./UiMenu.scss";

export interface UiMenuItem {
  key: string;
  label: string;
  hint?: string;
}

/**
 * UiMenu — frosted dropdown. The standard "pick one of N" menu: trigger pill
 * + floating glass list. Closes on outside pointer, Escape, or selection.
 */
export default defineComponent({
  name: "UiMenu",
  props: {
    modelValue: { type: String, default: "" },
    items: { type: Array as PropType<UiMenuItem[]>, required: true },
    ariaLabel: { type: String, default: "menu" },
  },
  emits: { "update:modelValue": (_key: string) => true },
  setup(props, { emit, slots }) {
    const open = ref(false);
    const root = ref<HTMLElement | null>(null);

    function close() { open.value = false; }
    function toggle() { open.value = !open.value; }

    function onDocPointer(e: PointerEvent) {
      if (root.value && !root.value.contains(e.target as Node)) close();
    }
    function onDocKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    onMounted(() => {
      document.addEventListener("pointerdown", onDocPointer);
      document.addEventListener("keydown", onDocKey);
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onDocKey);
    });

    function pick(key: string) {
      emit("update:modelValue", key);
      close();
    }

    return () => (
      <div class="ui-menu" ref={root}>
        <button
          type="button"
          class="ui-menu__trigger"
          aria-haspopup="listbox"
          aria-expanded={open.value}
          aria-label={props.ariaLabel}
          data-open={open.value ? "" : undefined}
          onClick={toggle}
        >
          {slots.trigger?.()}
          <ChevronDown size={14} class="ui-menu__chevron" />
        </button>
        <Transition name="ui-menu-pop">
          {open.value ? (
            <ul class="ui-menu__list" role="listbox">
              {props.items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={item.key === props.modelValue}
                    class={["ui-menu__item", item.key === props.modelValue ? "is-active" : ""].join(" ")}
                    onClick={() => pick(item.key)}
                  >
                    <span class="ui-menu__item-main">
                      <span class="ui-menu__item-label">{item.label}</span>
                      {item.hint ? <span class="ui-menu__item-hint">{item.hint}</span> : null}
                    </span>
                    {item.key === props.modelValue ? <Check size={14} class="ui-menu__item-check" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </Transition>
      </div>
    );
  },
});
