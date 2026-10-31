/** CrashPins — the suspect-matching core and the pinned block render.
 *  The matching function is pure; the renderer is driven from a
 *  hand-built pins object (the composable shape), so no store
 *  machinery is needed beyond the hikari + i18n mocks. */
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";

import type { InstalledMod, QuarantineEntry, SuspectMod } from "@/api";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@celestia-island/hikari", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    // A plain button passthrough: the click handler arrives as an attr and
    // lands on the rendered element (the renderer only needs a real button).
    HkButton: defineComponent({
      name: "HkButton",
      setup(_, { slots, attrs }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
    // Modal passthrough that honours modelValue: closed hides the slot, so
    // the window tests can assert what the open state actually shows.
    HkModal: defineComponent({
      name: "HkModal",
      props: ["modelValue", "title", "width", "footerActions"],
      setup(props, { slots }) {
        return () => (props.modelValue ? h("div", { class: "modal-stub" }, slots.default?.()) : null);
      },
    }),
    HkScrollContainer: defineComponent({
      name: "HkScrollContainer",
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    }),
    useToast: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  };
});

import { h } from "vue";
import { renderCrashPins, renderCrashPinsWindow, unitOfSuspect } from "./CrashPins";

function mod(paths: string[], name = paths[0]): InstalledMod {
  return {
    kind: "gui",
    name,
    relPath: paths[0],
    paths,
    disabled: false,
  };
}

describe("unitOfSuspect", () => {
  const installed = [
    mod(["gui"]),
    mod(["PnFMods/WoWSPProbe"], "WoWSP Probe"),
    mod(["banks/voice_ru"], "RU Voice"),
  ];

  it("matches a unit whose root IS the entry or sits under it", () => {
    expect(unitOfSuspect(installed, "gui")?.name).toBe("gui");
    expect(unitOfSuspect(installed, "PnFMods")?.name).toBe("WoWSP Probe");
    expect(unitOfSuspect(installed, "GUI")?.name).toBe("gui");
  });

  it("falls back to the display name and answers null for unknowns", () => {
    expect(unitOfSuspect(installed, "RU Voice")?.name).toBe("RU Voice");
    expect(unitOfSuspect(installed, "mystery_dir")).toBeNull();
  });
});

function makePins(
  suspects: SuspectMod[],
  quarantined: QuarantineEntry[],
) {
  return {
    crash: { quarantined, quarantineBusy: new Set<string>() },
    suspects: ref(suspects),
    recordId: ref<string | undefined>("crash-1"),
    quarantine: vi.fn(),
    restore: vi.fn(),
  };
}

/** One host mounting BOTH surfaces the way ResourcesView does: the
 *  collapsed launcher row (with its open callback) and the secondary
 *  window bound to an open ref. */
function host(pins: ReturnType<typeof makePins>, installed: InstalledMod[]) {
  const open = ref(false);
  const onOpen = vi.fn(() => (open.value = true));
  const onUpdate = vi.fn((v: boolean) => (open.value = v));
  const component = defineComponent({
    setup() {
      return () =>
        h("div", [
          renderCrashPins(pins as never, onOpen),
          renderCrashPinsWindow(pins as never, installed, open.value, onUpdate),
        ]);
    },
  });
  return { component, open, onOpen, onUpdate };
}

describe("the collapsed launcher row (renderCrashPins)", () => {
  const suspects: SuspectMod[] = [
    { name: "gui", evidence: "logMention", logLines: [] },
    { name: "mystery_dir", evidence: "recentChange", logLines: [] },
  ];
  const quarantined: QuarantineEntry[] = [
    { name: "mystery_dir", crashId: "crash-1", quarantinedAt: "2026-10-28T10:00:00Z" },
    { name: "gone_mod", crashId: "crash-0", quarantinedAt: "2026-10-27T10:00:00Z" },
  ];
  const installed = [mod(["gui"])];

  it("renders nothing without suspects or quarantined entries", () => {
    const wrapper = mount(host(makePins([], []), installed).component);
    expect(wrapper.find(".crash-pins").exists()).toBe(false);
  });

  it("collapses the pins into ONE row that counts suspects and quarantined", () => {
    const wrapper = mount(host(makePins(suspects, quarantined), installed).component);
    // The launcher is the only row in the sidebar block — the management
    // rows live in the window, not squeezed above the installed list.
    const rows = wrapper.findAll(".crash-pins .crash-pins__row");
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.classes()).toContain("is-summary");
    expect(row.text()).toContain("crash.modlist.title");
    expect(row.text()).toContain("crash.modlist.pinnedBadge · 2");
    expect(row.text()).toContain("crash.modlist.quarantinedBadge · 2");
  });

  it("hides the quarantined count while nothing is quarantined", () => {
    const wrapper = mount(host(makePins(suspects, []), installed).component);
    const row = wrapper.find(".crash-pins .crash-pins__row");
    expect(row.text()).toContain("crash.modlist.pinnedBadge · 2");
    expect(row.text()).not.toContain("crash.modlist.quarantinedBadge");
  });

  it("opens the management window on click and Enter", async () => {
    const hostScope = host(makePins(suspects, quarantined), installed);
    const wrapper = mount(hostScope.component);
    const row = wrapper.find(".crash-pins .crash-pins__row");
    await row.trigger("click");
    expect(hostScope.onOpen).toHaveBeenCalledTimes(1);
    expect(hostScope.open.value).toBe(true);
    await row.trigger("keydown", { key: "Enter" });
    expect(hostScope.onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("the management window (renderCrashPinsWindow)", () => {
  const suspects: SuspectMod[] = [
    { name: "gui", evidence: "logMention", logLines: [] },
    { name: "mystery_dir", evidence: "recentChange", logLines: [] },
  ];
  const quarantined: QuarantineEntry[] = [
    { name: "mystery_dir", crashId: "crash-1", quarantinedAt: "2026-10-28T10:00:00Z" },
    { name: "gone_mod", crashId: "crash-0", quarantinedAt: "2026-10-27T10:00:00Z" },
  ];
  const installed = [mod(["gui"])];

  it("shows nothing while closed and the management rows once open", async () => {
    const hostScope = host(makePins(suspects, quarantined), installed);
    const wrapper = mount(hostScope.component);
    expect(wrapper.find(".crash-pins--window").exists()).toBe(false);
    await wrapper.find(".crash-pins .crash-pins__row").trigger("click");
    expect(wrapper.find(".crash-pins--window").exists()).toBe(true);
    const rows = wrapper.findAll(".crash-pins--window .crash-pins__row");
    // 2 suspects (mystery_dir quarantined rides its suspect row) + 1 quarantined-only.
    expect(rows.length).toBe(3);
  });

  it("carries the unknown-suspect badges into the window", () => {
    const hostScope = host(makePins(suspects, []), installed);
    hostScope.open.value = true;
    const wrapper = mount(hostScope.component);
    const rows = wrapper.findAll(".crash-pins--window .crash-pins__row");
    expect(rows.length).toBe(2);
    const unknown = rows[1];
    expect(unknown.classes()).toContain("is-unknown");
    expect(unknown.text()).toContain("crash.suspects.unknownBadge");
    expect(unknown.text()).toContain("crash.modlist.pinnedBadge");
    const known = rows[0];
    expect(known.classes()).not.toContain("is-unknown");
    expect(known.text()).toContain("crash.suspects.evidence.logMention");
  });

  it("keeps the quarantined restore action wired through the window", async () => {
    const pins = makePins(suspects, quarantined);
    const hostScope = host(pins, installed);
    hostScope.open.value = true;
    const wrapper = mount(hostScope.component);
    const gone = wrapper
      .findAll(".crash-pins--window .crash-pins__row")
      .find((r) => r.text().includes("gone_mod"))!;
    expect(gone.classes()).toContain("is-quarantined");
    await gone.find("button").trigger("click");
    expect(pins.restore).toHaveBeenCalledWith("gone_mod");
  });
});