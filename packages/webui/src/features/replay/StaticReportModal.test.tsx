/**
 * Contract tests for StaticReportModal — the AI 战报's first-class window
 * (2026-11-03 extraction): HkModal owns the chrome; the host's data layer
 * (open/report/loading/error) flows in as props and close/seek/pick flow
 * back out. The panel child is stubbed — its formatters carry their own
 * suite; this pins the WINDOW wiring, the header COPY action's trip through
 * the shared copy-shot kit (features/share/useShareImage) included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";

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

/** The copy kit, reduced to what the wiring test pins: the render callback
 *  the modal hands it, the busy flag the header button reads, and the copy
 *  trigger the header button calls. The flag is a REAL ref (created in the
 *  factory, where vue is already initialised): the header button must
 *  re-render when the kit reports progress. */
const share = vi.hoisted(() => ({
  holder: { render: null as null | (() => Promise<Uint8Array>) },
  busy: { value: false } as { value: boolean },
  copyShot: vi.fn(),
}));

vi.mock("@/features/share/useShareImage", async () => {
  const { ref } = await import("vue");
  share.busy = ref(false);
  return {
    useShareImage: (render: () => Promise<Uint8Array>) => {
      share.holder.render = render;
      return { busy: share.busy, copyShot: share.copyShot };
    },
  };
});

/** The panel's capture handle — what the modal's copy action ultimately
 *  drives (the bytes the clipboard receives). */
const panel = vi.hoisted(() => ({
  capturePng: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

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
      expose({ capturePng: panel.capturePng });
      return () => h("div", { class: "panel-stub" });
    },
  }),
}));

function mountModal(overrides: Record<string, unknown> = {}) {
  return mount(StaticReportModal, {
    props: { open: true, report: null, loading: false, error: null, ...overrides },
  });
}

beforeEach(() => {
  share.busy.value = false;
  share.holder.render = null;
  share.copyShot.mockClear();
  panel.capturePng.mockClear();
  panel.capturePng.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

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
    const child = w.findComponent({ name: "StaticReportPanel" });
    await child.vm.$emit("pick", 42);
    await flushPromises();
    expect(w.emitted("pick")?.[0]).toEqual([42]);
    await child.vm.$emit("seek", 89000);
    await flushPromises();
    expect(w.emitted("seek")?.[0]).toEqual([89000]);
  });

  it("offers the long-image copy action only once a report is in hand", () => {
    expect(mountModal().find(".hk-modal-stub-actions button").exists()).toBe(false);
    const withReport = mountModal({ report });
    expect(withReport.find(".hk-modal-stub-actions button").exists()).toBe(true);
    expect(withReport.find(".hk-modal-stub-actions").text()).toContain("replay.report.copy");
  });

  it("drives the shared copy pipeline with the panel's PNG bytes", async () => {
    const w = mountModal({ report });
    await w.find(".hk-modal-stub-actions button").trigger("click");
    expect(share.copyShot).toHaveBeenCalledTimes(1);

    // The render callback the modal handed the kit is the panel capture —
    // the same call the clipboard write receives.
    expect(share.holder.render).toBeTypeOf("function");
    const bytes = await share.holder.render!();
    expect(panel.capturePng).toHaveBeenCalledTimes(1);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("surfaces the copy busy state on the header action", async () => {
    const w = mountModal({ report });
    share.busy.value = true;
    await nextTick();
    const actions = w.find(".hk-modal-stub-actions");
    expect(actions.text()).toContain("replay.report.copying");
  });

  it("shows the loading placeholder while the first fetch runs", () => {
    const w = mountModal({ loading: true });
    expect(w.find(".wowsp-report-modal__loading").exists()).toBe(true);
    expect(w.find(".wowsp-report-modal__loading").text()).toContain("replay.report.loading");
  });

  it("renders the failure card and hides the copy action with it", () => {
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
