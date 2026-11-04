/**
 * OverlayColumnsEditor — the water-table columns editor riding hikari's
 * HkDraggableList axis="horizontal" primitive (the #1736 migration off the
 * hand-rolled horizontal drag port).
 *
 * The primitive itself is REAL (hikari's own suite proves it standalone);
 * the mock only swaps the heavy externals: HkPopover renders its slot,
 * HkTabs mirrors the segmented control's click contract, HkButton /
 * HkIconButton pass clicks and disabled state through, and the statsPrefs
 * store is a hand-rolled reactive stub whose setOverlayColumns is the spy.
 * The drag gestures replay the primitive's own test idiom (happy-dom
 * PointerEvents with per-slot rect stubs).
 *
 * Pinned here:
 *  - the list renders with data-axis="horizontal", the a11y label, one
 *    slot per column (item = the label pair, handle = the card grip,
 *    actions = the delete), and NO list at all when the store is empty;
 *  - a real drag (press → |dx| arm past the primitive's 5px threshold →
 *    midpoint walk → pointerup) marks the source/placeholder faces, rises
 *    the primitive ghost, emits reorder ONCE, and commits the spliced
 *    list through the store (and through onChange on an external mount);
 *  - the actions lane's delete removes exactly its own column;
 *  - the add menu guards: at the limit the plus is disabled, a duplicate
 *    scope×metric combo disables the confirm, a free combo appends via
 *    the same commit path.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, reactive } from "vue";

import type { OverlayColumn } from "@/stores/statsPrefs";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

const mocks = vi.hoisted(() => ({
  /** One slot for the statsPrefs stub; every test seeds it before mount. */
  stores: {} as Record<string, unknown>,
}));

vi.mock("@/stores/statsPrefs", () => ({
  OVERLAY_COLUMN_LIMIT: 5,
  useStatsPrefsStore: () => mocks.stores.statsPrefs,
}));

vi.mock("@celestia-island/hikari", async (importOriginal) => {
  const { defineComponent, h } = await import("vue");
  // The REAL module — HkDraggableList rides through untouched (its own
  // standalone suite owns the drag contract; this suite only needs the
  // host wiring around it); only the heavy base widgets get stubbed.
  const actual = await importOriginal<typeof import("@celestia-island/hikari")>();

  const HkIconButton = defineComponent({
    name: "HkIconButton",
    inheritAttrs: false,
    setup(_props, { slots, attrs }) {
      return () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? []);
    },
  });

  const HkButton = defineComponent({
    name: "HkButton",
    inheritAttrs: false,
    setup(_props, { slots, attrs }) {
      return () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? []);
    },
  });

  const HkPopover = defineComponent({
    name: "HkPopover",
    props: ["modelValue", "anchorRef", "placement", "padding", "title", "sheetOnMobile", "closeOnBackdrop"],
    emits: ["update:modelValue"],
    setup(_props, { slots }) {
      return () => h("div", { class: "stub-HkPopover" }, slots.default?.() ?? []);
    },
  });

  const HkTabs = defineComponent({
    name: "HkTabs",
    props: { modelValue: { type: String, default: "" }, tabs: { type: Array, default: () => [] } },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "div",
          { class: "stub-HkTabs" },
          (props.tabs as Array<{ key: string; label: string }>).map((tab) =>
            h(
              "button",
              {
                key: tab.key,
                type: "button",
                "data-tab": tab.key,
                "data-active": tab.key === props.modelValue ? "" : undefined,
                onClick: () => emit("update:modelValue", tab.key),
              },
              tab.label,
            ),
          ),
        );
    },
  });

  return {
    ...actual,
    HkButton,
    HkIconButton,
    HkPopover,
    HkTabs,
    useBreakpoint: () => ({ isMobile: { value: false } }),
  };
});

import OverlayColumnsEditor from "./OverlayColumnsEditor";

enableAutoUnmount(afterEach);

const A: OverlayColumn = { scope: "global", metric: "winrate" };
const B: OverlayColumn = { scope: "global", metric: "pr" };
const C: OverlayColumn = { scope: "global", metric: "battles" };

interface EditorStoreStub {
  prefs: { overlayColumns: OverlayColumn[] };
  setOverlayColumns: Mock<(next: OverlayColumn[]) => void>;
}

/** A reactive store stub: the stub's setOverlayColumns actually applies
 *  the write so the re-render assertions see the committed list. */
function seedStore(cols: OverlayColumn[]): EditorStoreStub {
  const store = reactive<{ overlayColumns: OverlayColumn[] }>({
    overlayColumns: cols.map((c) => ({ ...c })),
  });
  const stub: EditorStoreStub = {
    prefs: store,
    setOverlayColumns: vi.fn((next: OverlayColumn[]) => {
      store.overlayColumns = next.map((c) => ({ ...c }));
    }),
  };
  mocks.stores.statsPrefs = stub;
  return stub;
}

function mountEditor(props?: {
  columns?: OverlayColumn[];
  onChange?: (cols: OverlayColumn[]) => void;
}): VueWrapper {
  return mount(OverlayColumnsEditor, { props });
}

// ── Primitive drag gestures (hikari's own test idiom) ──────────────────────

const PointerEventCtor: typeof MouseEvent =
  (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;

function fire(el: Element, type: string, x = 0, y = 0) {
  el.dispatchEvent(
    new PointerEventCtor(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
  );
}

function fireWin(type: string, x = 0, y = 0) {
  window.dispatchEvent(
    new PointerEventCtor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

function listRootOf(wrapper: VueWrapper): HTMLElement {
  return wrapper.element.querySelector(".hk-draggable-list") as HTMLElement;
}

function rowsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll(".hk-draggable-list-item")) as HTMLElement[];
}

/** happy-dom reports zero rects; pin the slots to a 100px-each single line
 *  [0..100][100..200][200..300] (40px tall) so the primitive's midpoint
 *  walk sees real geometry (same helper shape as hikari's suite). */
function layLine(root: HTMLElement): HTMLElement[] {
  const rows = rowsOf(root);
  rows.forEach((row, i) => {
    const left = i * 100;
    row.getBoundingClientRect = () =>
      ({
        left,
        top: 0,
        right: left + 100,
        bottom: 40,
        width: 100,
        height: 40,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return rows;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

afterEach(() => {
  // A drag released inside an assertion may leave the body-level ghost
  // riding past the unmount — keep tests hermetic.
  document.querySelectorAll(".hk-draggable-list-ghost").forEach((n) => n.remove());
});

const confirmButton = (wrapper: VueWrapper) =>
  wrapper
    .findAll("button")
    .find((b) => b.text() === "settings.overlayContent.colAddConfirm")!;

const metricTab = (wrapper: VueWrapper, key: string) =>
  wrapper.findAll(".overlay-columns__menu-group")[1]!.find(`button[data-tab="${key}"]`)!;

describe("OverlayColumnsEditor on HkDraggableList horizontal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the horizontal list with one slot per column", () => {
    seedStore([A, B, C]);
    const wrapper = mountEditor();

    const root = listRootOf(wrapper);
    expect(root.getAttribute("data-axis")).toBe("horizontal");
    expect(root.getAttribute("role")).toBe("list");
    expect(root.getAttribute("aria-label")).toBe("settings.overlayContent.columnsLabel");

    const rows = rowsOf(root);
    expect(rows).toHaveLength(3);
    // item slot: the label pair per column
    const metrics = wrapper.findAll(".overlay-columns__card-metric").map((n) => n.text());
    expect(metrics).toEqual([
      "settings.overlayContent.colMetricWinrate",
      "settings.overlayContent.colMetricPr",
      "settings.overlayContent.colMetricBattles",
    ]);
    // handle slot: the card grip rides the primitive's handle lane
    const grips = root.querySelectorAll(".hk-draggable-list-handle .overlay-columns__card-grip");
    expect(grips).toHaveLength(3);
    // actions slot: one delete per row, trailing the content lane
    const removes = wrapper.findAll('button[aria-label="settings.overlayContent.colRemove"]');
    expect(removes).toHaveLength(3);
  });

  it("renders the empty slab instead of a list when no column is set", () => {
    seedStore([]);
    const wrapper = mountEditor();

    expect(wrapper.element.querySelector(".hk-draggable-list")).toBeNull();
    expect(wrapper.find(".overlay-columns__empty").exists()).toBe(true);
  });

  it("commits a real drag's reorder through the store, once, at pointerup", async () => {
    const stub = seedStore([A, B, C]);
    const wrapper = mountEditor();
    const root = listRootOf(wrapper);
    const rows = layLine(root);
    const handle = rows[0]!.querySelector(".hk-draggable-list-handle") as HTMLElement;

    fire(handle, "pointerdown", 50, 20);
    // 10px of pure-X travel crosses the primitive's 5px |dx| arm; the
    // pointer at x=60 sits before B's midpoint (150) → B wears the
    // trailing placeholder line.
    fireWin("pointermove", 60, 20);
    await nextTick();
    expect(rows[0]!.hasAttribute("data-dragging")).toBe(true);
    expect(rows[1]!.getAttribute("data-placeholder")).toBe("after");

    // Past B and C's midpoints → C takes the drop line.
    fireWin("pointermove", 260, 20);
    await nextTick();
    expect(rows[1]!.hasAttribute("data-placeholder")).toBe(false);
    expect(rows[2]!.getAttribute("data-placeholder")).toBe("after");

    // The primitive's ghost rose next frame carrying the card markup.
    await nextFrame();
    const ghost = document.querySelector(".hk-draggable-list-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost!.querySelector(".overlay-columns__card-text")).not.toBeNull();

    // Commit-once-at-pointerup: ONE splice into the store.
    fireWin("pointerup");
    expect(stub.setOverlayColumns).toHaveBeenCalledTimes(1);
    expect(stub.setOverlayColumns).toHaveBeenCalledWith([B, C, A]);

    await nextTick();
    await nextFrame();
    // The ghost is gone and the DOM follows the committed order.
    expect(document.querySelector(".hk-draggable-list-ghost")).toBeNull();
    expect(wrapper.findAll(".overlay-columns__card-metric").map((n) => n.text())).toEqual([
      "settings.overlayContent.colMetricPr",
      "settings.overlayContent.colMetricBattles",
      "settings.overlayContent.colMetricWinrate",
    ]);
  });

  it("an external mount commits the same drag through onChange, not the store", async () => {
    const stub = seedStore([A, B]);
    const onChange = vi.fn();
    const wrapper = mountEditor({ columns: [A, B], onChange });
    const rows = layLine(listRootOf(wrapper));
    const handle = rows[0]!.querySelector(".hk-draggable-list-handle") as HTMLElement;

    fire(handle, "pointerdown", 50, 20);
    fireWin("pointermove", 60, 20); // arm; before B's midpoint → after-position 1
    fireWin("pointerup");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([B, A]);
    expect(stub.setOverlayColumns).not.toHaveBeenCalled();
  });

  it("the actions lane's delete removes exactly its own column", async () => {
    const stub = seedStore([A, B, C]);
    const wrapper = mountEditor();

    const removes = wrapper.findAll('button[aria-label="settings.overlayContent.colRemove"]');
    await removes[1]!.trigger("click");

    expect(stub.setOverlayColumns).toHaveBeenCalledTimes(1);
    expect(stub.setOverlayColumns).toHaveBeenCalledWith([A, C]);
  });

  it("at the limit the plus is disabled and no add can fire", () => {
    seedStore([A, B, C, { scope: "global", metric: "damage" }, { scope: "global", metric: "kd" }]);
    const stub = mocks.stores.statsPrefs as EditorStoreStub;
    const wrapper = mountEditor();

    const plus = wrapper.find('button[aria-label="settings.overlayContent.colAdd"]');
    expect(plus.attributes("disabled")).toBeDefined();
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    expect(stub.setOverlayColumns).not.toHaveBeenCalled();
  });

  it("the add menu appends a free combo; a duplicate combo disables the confirm", async () => {
    const stub = seedStore([A, B]);
    const wrapper = mountEditor();

    // Opening lands on the first FREE combo (scope-major walk): global +
    // damage — the confirm starts enabled.
    await wrapper.find('button[aria-label="settings.overlayContent.colAdd"]').trigger("click");
    expect(confirmButton(wrapper).attributes("disabled")).toBeUndefined();

    // Picking an existing combo (global winrate) disables the confirm.
    await metricTab(wrapper, "winrate").trigger("click");
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();

    // A free combo re-enables it and confirm appends through the store.
    await metricTab(wrapper, "battles").trigger("click");
    expect(confirmButton(wrapper).attributes("disabled")).toBeUndefined();
    await confirmButton(wrapper).trigger("click");

    expect(stub.setOverlayColumns).toHaveBeenCalledTimes(1);
    expect(stub.setOverlayColumns).toHaveBeenCalledWith([
      A,
      B,
      { scope: "global", metric: "battles" },
    ]);
  });
});
