/** The swimlane's host contract: rows render from the layer list, legacy
 *  rows ride lockedKeys, selection/report/apply stay prop callbacks (never
 *  IPC), and the pending banner appears exactly when the stack is dirty. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import { HkDraggableList } from "@celestia-island/hikari";

import type { ModLayer } from "@/api";
import { loadLocaleMessages } from "@/i18n";

import LayerStack from "./LayerStack";

enableAutoUnmount(afterEach);
// Render the real labels (rather than raw keys + intlify warnings).
beforeAll(async () => {
  await loadLocaleMessages("en-US");
});

function layer(patch: Partial<ModLayer> & { packId: string }): ModLayer {
  return {
    name: patch.packId,
    version: "1.0.0",
    category: "skin",
    layerClass: "override",
    enabled: true,
    priority: 0,
    slots: [],
    fileCount: 3,
    winningCount: 3,
    shadowedCount: 0,
    coveredBy: null,
    managed: true,
    ...patch,
  };
}

function mountStack(patch: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  const onReorder = vi.fn();
  const onApply = vi.fn();
  const onOpenReport = vi.fn();
  const onRetry = vi.fn();
  const wrapper = mount(LayerStack, {
    props: {
      layers: [
        layer({ packId: "top", shadowedCount: 2 }),
        layer({ packId: "legacy", managed: false }),
      ],
      rendered: false,
      slotConflicts: [{ slot: "ship:JSB039", packIds: ["top", "legacy"] }],
      onSelect,
      onReorder,
      onApply,
      onOpenReport,
      onRetry,
      ...patch,
    },
  });
  return { wrapper, onSelect, onReorder, onApply, onOpenReport, onRetry };
}

describe("LayerStack swimlane", () => {
  it("renders one lane per layer and locks the legacy rows", () => {
    const { wrapper } = mountStack();
    expect(wrapper.findAll(".layer-lane")).toHaveLength(2);
    expect(wrapper.findAll(".layer-lane--legacy")).toHaveLength(1);
    const list = wrapper.findComponent(HkDraggableList);
    expect(list.props("lockedKeys")).toEqual(["legacy"]);
    expect(list.props("items")).toHaveLength(2);
  });

  it("selects a layer on click and keeps drag/report actions on props", async () => {
    const { wrapper, onSelect, onReorder, onOpenReport } = mountStack();
    await wrapper.findAll(".layer-lane")[0].trigger("click");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ packId: "top" }));
    // The reorder callback is the only drag path — the component never
    // reaches IPC itself.
    const list = wrapper.findComponent(HkDraggableList);
    list.vm.$emit("reorder", 0, 1);
    expect(onReorder).toHaveBeenCalledWith(0, 1);
    // Text may be a raw key under the test i18n; the report action is the
    // header strip's first button.
    const report = wrapper.find(".layer-stack__tools button");
    expect(report.exists()).toBe(true);
    await report.trigger("click");
    expect(onOpenReport).toHaveBeenCalled();
  });

  it("shows the pending banner only while the stack is dirty", async () => {
    const clean = mountStack({ rendered: true });
    expect(clean.wrapper.find(".layer-stack__pending").exists()).toBe(false);
    const dirty = mountStack();
    expect(dirty.wrapper.find(".layer-stack__pending").exists()).toBe(true);
    await dirty.wrapper.find(".layer-stack__pending button").trigger("click");
    expect(dirty.onApply).toHaveBeenCalled();
  });
});
