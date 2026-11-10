/** CrashPins — the suspect-matching core and the pinned block render.
 *  The matching function is pure and most of the renderer runs off a
 *  hand-built pins object (the composable shape); the permanent-delete
 *  flow is the REAL useCrashPins composable driven against a fake crash
 *  store, because the post-delete analysis refresh is composable-owned
 *  behavior no hand-built double would exercise. */
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";

import type { GameCrashRecord, InstalledMod, QuarantineEntry, SuspectMod } from "@/api";

/** The crash-store fake the real composable runs against (the hand-built
 *  pins objects below bypass it), plus the shared toast spies the delete
 *  contract asserts on. */
const crashFake = vi.hoisted(() => ({
  history: [] as GameCrashRecord[],
  quarantined: [] as QuarantineEntry[],
  quarantineBusy: new Set<string>(),
  analyze: vi.fn(),
  loadQuarantined: vi.fn(),
  quarantine: vi.fn(),
  restore: vi.fn(),
  deleteEntry: vi.fn(),
  refreshAnalysis: vi.fn(),
}));
const toastFake = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/stores/crash", () => ({ useCrashStore: () => crashFake }));

vi.mock("@/i18n", () => ({
  // Keys in, keys out; interpolation params are appended so assertions can
  // see WHICH entry a message names (only the delete confirm uses params).
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(" ")}` : key,
}));
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
    // AppTag's hikari base — a class-merging span passthrough.
    HkTag: defineComponent({
      name: "HkTag",
      inheritAttrs: false,
      setup(_, { slots, attrs }) {
        return () => h("span", { ...attrs, class: ["hk-tag", attrs.class] }, [slots.icon?.(), slots.default?.()]);
      },
    }),
    HkScrollContainer: defineComponent({
      name: "HkScrollContainer",
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    }),
    // Confirm-dialog passthrough: closed renders nothing; open renders the
    // message plus the confirm/cancel pair, emitting the real component's
    // confirm-then-close order (confirm, update:open false).
    HkConfirmDialog: defineComponent({
      name: "HkConfirmDialog",
      props: ["open", "title", "message", "confirmLabel", "cancelLabel", "confirmVariant", "loading"],
      emits: ["confirm", "cancel", "update:open"],
      setup(props, { emit }) {
        return () =>
          props.open
            ? h("div", { class: "confirm-dialog-stub" }, [
                h("p", { class: "confirm-message" }, props.message),
                h(
                  "button",
                  {
                    class: "confirm",
                    onClick: () => {
                      emit("confirm");
                      emit("update:open", false);
                    },
                  },
                  props.confirmLabel,
                ),
                h(
                  "button",
                  {
                    class: "cancel",
                    onClick: () => {
                      emit("cancel");
                      emit("update:open", false);
                    },
                  },
                  props.cancelLabel,
                ),
              ])
            : null;
      },
    }),
    useToast: () => toastFake,
  };
});

import { h } from "vue";
import {
  renderCrashPins,
  renderCrashPinsWindow,
  unitOfSuspect,
  useCrashPins,
} from "./CrashPins";

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
  const deleteTarget = ref<string | null>(null);
  return {
    crash: { quarantined, quarantineBusy: new Set<string>() },
    suspects: ref(suspects),
    recordId: ref<string | undefined>("crash-1"),
    /** The entry the delete confirmation is armed for (the real composable
     *  holds this same ref). */
    deleteTarget,
    quarantine: vi.fn(),
    restore: vi.fn(),
    askDelete: vi.fn((name: string) => {
      deleteTarget.value = name;
    }),
    deleteQuarantined: vi.fn(),
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

  /** The action labels one management row's buttons carry. */
  function rowActions(row: { findAll: (sel: string) => { text: () => string }[] }) {
    return row.findAll("button").map((b) => b.text());
  }

  it("offers permanent delete next to restore on both quarantined row kinds", () => {
    const hostScope = host(makePins(suspects, quarantined), installed);
    hostScope.open.value = true;
    const wrapper = mount(hostScope.component);
    const rows = wrapper.findAll(".crash-pins--window .crash-pins__row");
    // mystery_dir rides its quarantined SUSPECT row; gone_mod is listed
    // only through the quarantine manifest.
    const suspectRow = rows.find((r) => r.text().includes("mystery_dir"))!;
    expect(suspectRow.text()).toContain("crash.modlist.quarantinedBadge");
    expect(rowActions(suspectRow)).toEqual([
      "crash.suspects.restore",
      "crash.suspects.delete",
    ]);
    const onlyRow = rows.find((r) => r.text().includes("gone_mod"))!;
    expect(rowActions(onlyRow)).toEqual([
      "crash.suspects.restore",
      "crash.suspects.delete",
    ]);
    // The healthy suspect row keeps its quarantine WIRING and gains no
    // delete action (only quarantined entries carry one).
    const healthy = rows.find((r) => r.text().includes("gui"))!;
    expect(rowActions(healthy)).toEqual(["crash.suspects.quarantine"]);
  });

  it("confirms before permanently deleting a quarantine-only entry", async () => {
    const pins = makePins(suspects, quarantined);
    const hostScope = host(pins, installed);
    hostScope.open.value = true;
    const wrapper = mount(hostScope.component);
    const gone = wrapper
      .findAll(".crash-pins--window .crash-pins__row")
      .find((r) => r.text().includes("gone_mod"))!;
    const del = gone
      .findAll("button")
      .find((b) => b.text() === "crash.suspects.delete")!;
    await del.trigger("click");
    expect(pins.askDelete).toHaveBeenCalledExactlyOnceWith("gone_mod");
    // Irreversible: nothing runs before the confirmation.
    expect(pins.deleteQuarantined).not.toHaveBeenCalled();
    const dialog = wrapper.find(".confirm-dialog-stub");
    expect(dialog.exists()).toBe(true);
    expect(dialog.find(".confirm-message").text()).toContain("gone_mod");
    await dialog.find("button.confirm").trigger("click");
    expect(pins.deleteQuarantined).toHaveBeenCalledExactlyOnceWith("gone_mod");
    // The confirmation state is dropped with the click.
    expect(pins.deleteTarget.value).toBeNull();
  });

  it("confirms before permanently deleting a quarantined suspect", async () => {
    const pins = makePins(suspects, quarantined);
    const hostScope = host(pins, installed);
    hostScope.open.value = true;
    const wrapper = mount(hostScope.component);
    const suspectRow = wrapper
      .findAll(".crash-pins--window .crash-pins__row")
      .find((r) => r.text().includes("mystery_dir"))!;
    const del = suspectRow
      .findAll("button")
      .find((b) => b.text() === "crash.suspects.delete")!;
    await del.trigger("click");
    expect(pins.askDelete).toHaveBeenCalledExactlyOnceWith("mystery_dir");
    expect(pins.deleteQuarantined).not.toHaveBeenCalled();
    await wrapper.find(".confirm-dialog-stub button.confirm").trigger("click");
    expect(pins.deleteQuarantined).toHaveBeenCalledExactlyOnceWith("mystery_dir");
  });

  it("cancels the permanent delete without touching the entry", async () => {
    const pins = makePins(suspects, quarantined);
    const hostScope = host(pins, installed);
    hostScope.open.value = true;
    const wrapper = mount(hostScope.component);
    const gone = wrapper
      .findAll(".crash-pins--window .crash-pins__row")
      .find((r) => r.text().includes("gone_mod"))!;
    await gone
      .findAll("button")
      .find((b) => b.text() === "crash.suspects.delete")!
      .trigger("click");
    await wrapper.find(".confirm-dialog-stub button.cancel").trigger("click");
    expect(pins.deleteQuarantined).not.toHaveBeenCalled();
    expect(pins.deleteTarget.value).toBeNull();
  });
});

describe("the permanent-delete flow (real useCrashPins)", () => {
  const record: GameCrashRecord = {
    id: "crash-1",
    detectedAt: "2026-10-28T10:00:00Z",
    pid: 4242,
    imageName: "WorldOfWarships64.exe",
    gameRoot: "D:/Games/World of Warships",
    source: "event-log",
    modsActive: true,
    status: "dismissed",
  };
  const quarantine: QuarantineEntry[] = [
    { name: "gone_mod", crashId: "crash-1", quarantinedAt: "2026-10-27T10:00:00Z" },
  ];

  /** Seed the fake store the composable reads at setup. */
  function seed() {
    crashFake.history = [record];
    crashFake.quarantined = quarantine;
    crashFake.quarantineBusy = new Set<string>();
    crashFake.analyze.mockReset().mockResolvedValue({ suspects: [] });
    crashFake.loadQuarantined.mockReset().mockResolvedValue(undefined);
    crashFake.quarantine.mockReset();
    crashFake.restore.mockReset();
    crashFake.deleteEntry.mockReset().mockResolvedValue([]);
    crashFake.refreshAnalysis.mockReset().mockResolvedValue(undefined);
    toastFake.success.mockReset();
    toastFake.error.mockReset();
  }

  it("drops the cached analysis after the delete so no suspect row lingers", async () => {
    seed();
    const pins = useCrashPins(ref("D:/Games/World of Warships"));
    // The composable's initial suspects/manifest loads are async by design.
    await flushPromises();
    const hostScope = host(pins as never, []);
    hostScope.open.value = true;
    const wrapper = mount(hostScope.component);
    const gone = wrapper
      .findAll(".crash-pins--window .crash-pins__row")
      .find((r) => r.text().includes("gone_mod"))!;
    await gone
      .findAll("button")
      .find((b) => b.text() === "crash.suspects.delete")!
      .trigger("click");
    await wrapper.find(".confirm-dialog-stub button.confirm").trigger("click");
    await flushPromises();
    expect(crashFake.deleteEntry).toHaveBeenCalledWith(
      "gone_mod",
      "D:/Games/World of Warships",
    );
    expect(toastFake.success).toHaveBeenCalledWith(
      "gone_mod — crash.suspects.deleteDone",
    );
    // The cached analysis describes the PRE-delete world: the composable
    // must re-derive THIS record's view or the deleted suspect row stays
    // listed as a plain suspect offering the quarantine action.
    expect(crashFake.refreshAnalysis).toHaveBeenCalledExactlyOnceWith("crash-1");
    expect(crashFake.refreshAnalysis.mock.invocationCallOrder[0]).toBeGreaterThan(
      crashFake.deleteEntry.mock.invocationCallOrder[0]!,
    );
    // Both lists reload once the refresh settled.
    expect(crashFake.loadQuarantined).toHaveBeenCalled();
    expect(crashFake.analyze).toHaveBeenCalled();
  });

  it("keeps a successful delete successful when the re-analysis fails", async () => {
    seed();
    crashFake.refreshAnalysis.mockRejectedValue(new Error("analysis failed"));
    const pins = useCrashPins(ref("D:/Games/World of Warships"));
    await flushPromises();
    // Resolves — the explicit best-effort catch absorbs the analysis fault.
    await expect(pins.deleteQuarantined("gone_mod")).resolves.toBeUndefined();
    expect(crashFake.deleteEntry).toHaveBeenCalledWith(
      "gone_mod",
      "D:/Games/World of Warships",
    );
    expect(crashFake.refreshAnalysis).toHaveBeenCalledWith("crash-1");
    // The delete's success toast stands, and the failure never surfaces as
    // an error toast.
    expect(toastFake.success).toHaveBeenCalledWith(
      "gone_mod — crash.suspects.deleteDone",
    );
    expect(toastFake.error).not.toHaveBeenCalled();
    // The reload pass still runs after the failed refresh.
    expect(crashFake.loadQuarantined).toHaveBeenCalled();
  });
});