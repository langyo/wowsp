/**
 * Plan-slot bar: the row of plan chips above a plan stage — or, in `tree`
 * layout (the tactics page's left panel), a left-leaning branch tree. One
 * map can hold several plans (variants of a setup); clicking a chip switches
 * the board's document, "+" starts an empty plan, the copy button clones the
 * current plan into a new chip, the branch button forks the current plan AT
 * THE PLAYHEAD (the copy keeps everything up to that battle second), and the
 * trash removes the current plan after a second confirming click. Double-
 * click a chip to rename it. Tree layout indents children under their fork
 * parent (root at the top, left-aligned).
 */
import { computed, defineComponent, nextTick, ref, type PropType } from "vue";
import { Copy, Download, GitBranch, Plus, Trash2, Upload } from "@lucide/vue";
import { HkTooltip } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import { fmtClock } from "./timelineModel";
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
    /** Bundle share: export every plan of the map / pick a bundle file. */
    onExport: { type: Function as PropType<() => void>, required: true },
    onImport: { type: Function as PropType<() => void>, required: true },
    /** Fork the current plan at the playhead (tree layout's main action).
     *  Absent in the chips layout (a plain duplicate still exists there). */
    onBranch: { type: Function as PropType<() => void>, default: undefined },
    /** `chips` = the horizontal row above the stage; `tree` = the vertical
     *  indented branch tree for the tactics page's left panel. */
    layout: { type: String as PropType<"chips" | "tree">, default: "chips" },
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

    /** Tree layout rows: slots ordered so every child follows its parent,
     *  each with its fork depth (indent level) and branch clock. Orphans
     *  (a parent removed earlier) fold back to the root row. */
    const treeRows = computed(() => {
      const byId = new Map(props.slots.map((s) => [s.id, s]));
      // Depth-first walk from the roots keeps siblings in insertion order.
      const children = new Map<string, PlanSlot[]>();
      const roots: PlanSlot[] = [];
      for (const s of props.slots) {
        if (s.parent != null && byId.has(s.parent)) {
          const list = children.get(s.parent);
          if (list) list.push(s);
          else children.set(s.parent, [s]);
        } else {
          roots.push(s);
        }
      }
      const rows: { slot: PlanSlot; index: number; depth: number }[] = [];
      const walk = (slot: PlanSlot, depth: number): void => {
        rows.push({ slot, index: props.slots.indexOf(slot), depth });
        for (const c of children.get(slot.id) ?? []) walk(c, depth + 1);
      };
      for (const r of roots) walk(r, 0);
      // Any slot a cycle hid from the walk still shows (appended, depth 0).
      for (let i = 0; i < props.slots.length; i++) {
        if (!rows.some((r) => r.slot === props.slots[i])) rows.push({ slot: props.slots[i], index: i, depth: 0 });
      }
      return rows;
    });

    return () =>
      props.layout === "tree" ? (
        <div class="plan-slots plan-slots--tree" onClick={(e: MouseEvent) => e.stopPropagation()}>
          {treeRows.value.map(({ slot, index, depth }) => (
            <span
              key={slot.id}
              class="plan-slots__node"
              style={{ paddingLeft: `${depth * 14}px` }}
            >
              {depth > 0 ? <span class="plan-slots__node-branch" /> : null}
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
                  {props.names[index]}
                  {slot.branchT != null ? (
                    <span class="plan-slots__fork">T+{fmtClock(slot.branchT)}</span>
                  ) : null}
                </button>
              )}
            </span>
          ))}
          <span class="plan-slots__actions plan-slots__actions--col">
            {props.onBranch ? (
              <HkTooltip text={i18nT("tactics.slots.branch")} placement="right">
                <button
                  type="button"
                  class="plan-slots__btn plan-slots__btn--branch"
                  onClick={() => {
                    armed.value = false;
                    props.onBranch!();
                  }}
                >
                  <GitBranch size={12} />
                </button>
              </HkTooltip>
            ) : null}
            <HkTooltip text={i18nT("tactics.slots.add")} placement="right">
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
            <HkTooltip text={i18nT("tactics.slots.exportBundle")} placement="right">
              <button
                type="button"
                class="plan-slots__btn"
                onClick={() => {
                  armed.value = false;
                  props.onExport();
                }}
              >
                <Download size={12} />
              </button>
            </HkTooltip>
            <HkTooltip text={i18nT("tactics.slots.importBundle")} placement="right">
              <button
                type="button"
                class="plan-slots__btn"
                onClick={() => {
                  armed.value = false;
                  props.onImport();
                }}
              >
                <Upload size={12} />
              </button>
            </HkTooltip>
            {props.slots.length > 1 ? (
              <HkTooltip
                text={i18nT(armed.value ? "tactics.slots.removeConfirm" : "tactics.slots.remove")}
                placement="right"
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
      ) : chipsView();

    function chipsView() {
      return (
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
          <HkTooltip text={i18nT("tactics.slots.exportBundle")} placement="bottom">
            <button
              type="button"
              class="plan-slots__btn"
              onClick={() => {
                armed.value = false;
                props.onExport();
              }}
            >
              <Download size={12} />
            </button>
          </HkTooltip>
          <HkTooltip text={i18nT("tactics.slots.importBundle")} placement="bottom">
            <button
              type="button"
              class="plan-slots__btn"
              onClick={() => {
                armed.value = false;
                props.onImport();
              }}
            >
              <Upload size={12} />
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
    }
  },
});
