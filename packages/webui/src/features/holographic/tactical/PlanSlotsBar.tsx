/**
 * Plan-slot bar: the row of plan chips above a plan stage. One map can hold
 * several plans (variants of a setup); clicking a chip switches the board's
 * document, "+" starts an empty plan, the copy button clones the current
 * plan into a new chip, and the trash removes the current plan after a
 * second confirming click (its tooltip says so). Double-click a chip to
 * rename it.
 */
import { defineComponent, nextTick, ref, type PropType } from "vue";
import { Copy, Plus, Trash2 } from "@lucide/vue";
import { HkTooltip } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import type { PlanSlot } from "./planSlots";
import "./PlanSlotsBar.scss";

export default defineComponent({
  name: "PlanSlotsBar",
  props: {
    slots: { type: Array as PropType<PlanSlot[]>, required: true },
    /** Display names with the "Plan N" fallback already applied. */
    names: { type: Array as PropType<string[]>, required: true },
    activeId: { type: String, required: true },
    onSelect: { type: Function as PropType<(id: string) => void>, required: true },
    onAdd: { type: Function as PropType<() => void>, required: true },
    onDuplicate: { type: Function as PropType<() => void>, required: true },
    onRename: { type: Function as PropType<(id: string, name: string) => void>, required: true },
    onRemove: { type: Function as PropType<(id: string) => void>, required: true },
  },
  setup(props) {
    const renaming = ref<{ id: string; value: string } | null>(null);
    const renameInput = ref<HTMLInputElement | null>(null);
    /** First click on the trash arms it; a click elsewhere disarms. */
    const armed = ref(false);

    function beginRename(id: string, name: string): void {
      renaming.value = { id, value: name };
      armed.value = false;
      void nextTick(() => renameInput.value?.focus());
    }
    function commitRename(): void {
      const ed = renaming.value;
      renaming.value = null;
      if (!ed) return;
      props.onRename(ed.id, ed.value);
    }
    function onRenameKeydown(e: KeyboardEvent): void {
      e.stopPropagation();
      if (e.key === "Enter") commitRename();
      else if (e.key === "Escape") renaming.value = null;
    }
    function clickChip(id: string): void {
      armed.value = false;
      if (id !== props.activeId) props.onSelect(id);
    }
    function clickRemove(): void {
      if (!armed.value) {
        armed.value = true;
        return;
      }
      armed.value = false;
      props.onRemove(props.activeId);
    }

    return () => (
      <div class="plan-slots" onClick={(e: MouseEvent) => e.stopPropagation()}>
        {props.slots.map((slot, i) => (
          <span key={slot.id} class="plan-slots__wrap">
            {renaming.value?.id === slot.id ? (
              <input
                ref={renameInput}
                class="plan-slots__rename"
                value={renaming.value.value}
                title={i18nT("tactics.slots.rename")}
                onInput={(e: Event) => {
                  if (renaming.value) renaming.value.value = (e.target as HTMLInputElement).value;
                }}
                onKeydown={onRenameKeydown}
                onBlur={commitRename}
                onClick={(e: MouseEvent) => e.stopPropagation()}
              />
            ) : (
              <button
                type="button"
                class={["plan-slots__chip", slot.id === props.activeId ? "plan-slots__chip--on" : ""]}
                title={i18nT("tactics.slots.rename")}
                onClick={() => clickChip(slot.id)}
                onDblclick={() => beginRename(slot.id, slot.name)}
              >
                {props.names[i]}
              </button>
            )}
          </span>
        ))}
        <span class="plan-slots__actions">
          <HkTooltip text={i18nT("tactics.slots.add")} placement="bottom">
            <button
              type="button"
              class="plan-slots__btn"
              onClick={() => {
                armed.value = false;
                props.onAdd();
              }}
            >
              <Plus size={12} />
            </button>
          </HkTooltip>
          <HkTooltip text={i18nT("tactics.slots.duplicate")} placement="bottom">
            <button
              type="button"
              class="plan-slots__btn"
              onClick={() => {
                armed.value = false;
                props.onDuplicate();
              }}
            >
              <Copy size={12} />
            </button>
          </HkTooltip>
          {props.slots.length > 1 ? (
            <HkTooltip
              text={i18nT(armed.value ? "tactics.slots.removeConfirm" : "tactics.slots.remove")}
              placement="bottom"
            >
              <button
                type="button"
                class={["plan-slots__btn", armed.value ? "plan-slots__btn--danger" : ""]}
                onClick={clickRemove}
              >
                <Trash2 size={12} />
              </button>
            </HkTooltip>
          ) : null}
        </span>
      </div>
    );
  },
});
