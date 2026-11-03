/**
 * Contract tests for StaticReportModal — the AI 战报's first-class window
 * (2026-11-03 extraction): HkModal owns the chrome; the host's data layer
 * (open/report/loading/error) flows in as props and close/seek/pick flow
 * back out. The panel child is stubbed — its formatters carry their own
 * suite; this pins the WINDOW wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import StaticReportModal from "./StaticReportModal";
import ErrorCard from "@/components/base/ErrorCard";
import { HkModal } from "@celestia-island/hikari";
import type { StaticReport } from "@/api";

enableAutoUnmount(afterEach);

const report = {
  replayId: "20261103_1",
  entityId: 7,
  roster: [],
} as unknown as StaticReport;

// The hikari window contract, reduced to what the wiring test pins: the
// content class + title reach the modal surface, headerActions render, and
// dismissal emits update:modelValue(false). Defined INSIDE the factory —
// vi.mock hoists above every top-level const.
vi.mock("@celestia-island/hikari", () => {
  const HkModalStub = defineComponent({
    name: "HkModal",
    props: ["modelValue", "title", "width", "contentClass"],
    emits: ["update:modelValue"],
    setup(props, { slots }) {
      return () =>
        props.modelValue
          ? h("div", { class: ["hk-modal-stub", props.contentClass] }, [
              h("div", { class: "hk-modal-stub-title" }, props.title),
              h("div", { class: "hk-modal-stub-actions" }, slots.headerActions?.()),
              h("div", { class: "hk-modal-stub-body" }, slots.default?.()),
            ])
          : null;
    },
  });
  const HkButtonStub = defineComponent({
    name: "HkButton",
    props: ["loading", "variant", "size", "disabled"],
    setup(_, { slots, attrs }) {
      return () => h("button", attrs, slots.default?.());
    },
  });
  const HkSpinnerStub = defineComponent({ name: "HkSpinner", render: () => null });
  // ErrorCard reads the breakpoint in its setup; the stub keeps the test
  // on the desktop layout.
  const useBreakpoint = () => ({ isMobile: { value: false } });
  // ErrorCard's internals: the raw-details tree + the landing frame it
  // delegates to on failures.
  const HkJsonTreeStub = defineComponent({
    name: "HkJsonTree",
    props: ["value", "ariaLabel"],
    render: () => null,
  });
  const HkErrorLandingStub = defineComponent({
    name: "HkErrorLanding",
    props: ["title", "error"],
    render: () => null,
  });
  return {
    HkModal: HkModalStub,
    HkButton: HkButtonStub,
    HkSpinner: HkSpinnerStub,
    useBreakpoint,
    HkJsonTree: HkJsonTreeStub,
    HkErrorLanding: HkErrorLandingStub,
  };
});

vi.mock("@/features/holographic/StaticReportPanel", () => ({
  default: defineComponent({
    name: "StaticReportPanel",
    props: ["report", "loading"],
    setup(_, { expose }) {
      expose({ exportPng: vi.fn().mockResolvedValue(undefined) });
      return () => h("div", { class: "panel-stub" });
    },
  }),
}));

function mountModal(overrides: Record<string, unknown> = {}) {
  return mount(StaticReportModal, {
    props: { open: true, report: null, loading: false, error: null, ...overrides },
  });
}

describe("StaticReportModal", () => {
  it("mounts the hikari window with the unified title and reading frame", () => {
    const w = mountModal();
    const modal = w.find(".hk-modal-stub");
    expect(modal.exists()).toBe(true);
    expect(modal.classes()).toContain("wowsp-report-modal");
    expect(w.find(".hk-modal-stub-title").text()).toBe("replay.report.title");
  });

  it("renders the embedded panel inside and forwards pick/seek through it", async () => {
    const w = mountModal({ report });
    expect(w.find(".panel-stub").exists()).toBe(true);
    const panel = w.findComponent({ name: "StaticReportPanel" });
    await panel.vm.$emit("pick", 42);
    await flushPromises();
    expect(w.emitted("pick")?.[0]).toEqual([42]);
    await panel.vm.$emit("seek", 89000);
    await flushPromises();
    expect(w.emitted("seek")?.[0]).toEqual([89000]);
  });

  it("offers the export action only once a report is in hand", () => {
    expect(mountModal().find(".hk-modal-stub-actions button").exists()).toBe(false);
    const withReport = mountModal({ report });
    expect(withReport.find(".hk-modal-stub-actions button").exists()).toBe(true);
    expect(withReport.find(".hk-modal-stub-actions").text()).toContain("replay.report.export");
  });

  it("shows the loading placeholder while the first fetch runs", () => {
    const w = mountModal({ loading: true });
    expect(w.find(".wowsp-report-modal__loading").exists()).toBe(true);
    expect(w.find(".wowsp-report-modal__loading").text()).toContain("replay.report.loading");
  });

  it("renders the failure card and hides the export with it", () => {
    const w = mountModal({ error: "boom" });
    const card = w.findComponent(ErrorCard);
    expect(card.exists()).toBe(true);
    expect(card.props("error")).toBe("boom");
    expect(w.find(".hk-modal-stub-actions button").exists()).toBe(false);
  });

  it("emits close when the window is dismissed", async () => {
    const w = mountModal();
    await w.findComponent(HkModal).vm.$emit("update:modelValue", false);
    await flushPromises();
    expect(w.emitted("close")).toHaveLength(1);
  });
});
