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
    useToast: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  };
});

import { h } from "vue";
import { renderCrashPins, unitOfSuspect } from "./CrashPins";

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

function host(pins: ReturnType<typeof makePins>, installed: InstalledMod[]) {
  return defineComponent({
    setup() {
      return () => h("div", [renderCrashPins(pins as never, installed)]);
    },
  });
}

describe("renderCrashPins", () => {
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
    const wrapper = mount(host(makePins([], []), installed));
    expect(wrapper.find(".crash-pins").exists()).toBe(false);
  });

  it("pins known and unknown suspects with the required badges", () => {
    const wrapper = mount(host(makePins(suspects, []), installed));
    const rows = wrapper.findAll(".crash-pins__row");
    expect(rows.length).toBe(2);
    const unknown = rows[1];
    expect(unknown.classes()).toContain("is-unknown");
    expect(unknown.text()).toContain("crash.suspects.unknownBadge");
    expect(unknown.text()).toContain("crash.modlist.pinnedBadge");
    const known = rows[0];
    expect(known.classes()).not.toContain("is-unknown");
    expect(known.text()).toContain("crash.suspects.evidence.logMention");
  });

  it("shows quarantined entries pinned with a restore action", async () => {
    const pins = makePins(suspects, quarantined);
    const wrapper = mount(host(pins, installed));
    const rows = wrapper.findAll(".crash-pins__row");
    // 2 suspects (mystery_dir quarantined rides its suspect row) + 1 quarantined-only.
    expect(rows.length).toBe(3);
    const gone = rows[2];
    expect(gone.classes()).toContain("is-quarantined");
    expect(gone.text()).toContain("gone_mod");
    await gone.find("button").trigger("click");
    expect(pins.restore).toHaveBeenCalledWith("gone_mod");
  });
});