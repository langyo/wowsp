/** CrashSection: the settings crash-report pane. The api module is
 *  mocked (the same seam the crash store tests use); the section runs
 *  against the real stores. Covers the empty state, the record list,
 *  the findings render (message + severity chip) and the export
 *  action plumbing. */
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { createPinia, setActivePinia } from "pinia";

import { useToast } from "@celestia-island/hikari";

import type { CrashAnalysis, GameCrashRecord } from "@/api";
import { initLocaleMessages, t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useCrashStore } from "@/stores/crash";

vi.mock("@/api", () => ({
  api: {
    listenGameCrash: vi.fn(() => Promise.resolve(() => undefined)),
    listGameCrashes: vi.fn(),
    dismissGameCrash: vi.fn(),
    markGameCrashViewed: vi.fn(() => Promise.resolve([])),
    dismissAllGameCrashes: vi.fn(),
    analyzeGameCrash: vi.fn(),
    exportGameCrashReport: vi.fn(),
    listQuarantinedMods: vi.fn(() => Promise.resolve([])),
    quarantineMod: vi.fn(),
    restoreMod: vi.fn(),
    restartGame: vi.fn(() =>
      Promise.resolve({
        gameRoot: "D:/Games/World of Warships",
        exePath: "D:/Games/World of Warships/bin/WorldOfWarships64.exe",
        pid: 77,
      }),
    ),
    modHubSetSafeMode: vi.fn(() => Promise.resolve(true)),
    modHubSafeMode: vi.fn(() => Promise.resolve(false)),
    safeguardEnabled: vi.fn(() => Promise.resolve(true)),
    setSafeguard: vi.fn(),
    scanRecentCrashes: vi.fn(() => Promise.resolve([])),
    listIgnoredSuspects: vi.fn(() => Promise.resolve([])),
    ignoreSuspect: vi.fn(),
    restoreSuspect: vi.fn(),
    deleteEntry: vi.fn(),
  },
}));

import { api } from "@/api";
import CrashSection from "./CrashSection";

const mocked = {
  list: vi.mocked(api.listGameCrashes),
  markViewed: vi.mocked(api.markGameCrashViewed),
  dismissAll: vi.mocked(api.dismissAllGameCrashes),
  analyze: vi.mocked(api.analyzeGameCrash),
  exportReport: vi.mocked(api.exportGameCrashReport),
  deleteEntry: vi.mocked(api.deleteEntry),
  ignore: vi.mocked(api.ignoreSuspect),
  restore: vi.mocked(api.restoreSuspect),
  quarantineMod: vi.mocked(api.quarantineMod),
  listQuarantined: vi.mocked(api.listQuarantinedMods),
  safeMode: vi.mocked(api.modHubSetSafeMode),
  restart: vi.mocked(api.restartGame),
};

/** An install the section resolves only through the active selection. */
const ACTIVE = "D:/Games/ActiveInstall";

/** The suspects window's footer bulk action (teleported to body). */
function bulkButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button")].find(
    (b) => (b.textContent ?? "").includes(t("crash.suspects.quarantineAll")),
  );
}

/** The records window's footer reset action (teleported to body). */
function resetButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button")].find(
    (b) => (b.textContent ?? "").includes(t("crash.section.resetAll")),
  );
}

function record(overrides: Partial<GameCrashRecord> = {}): GameCrashRecord {
  return {
    id: "crash-1",
    detectedAt: "2026-10-28T10:00:00Z",
    pid: 4242,
    imageName: "WorldOfWarships64.exe",
    gameRoot: "D:/Games/World of Warships",
    source: "event-log",
    modsActive: true,
    status: "new",
    ...overrides,
  };
}

const analysis: CrashAnalysis = {
  record: record(),
  findings: [
    { code: "exceptionAccessViolation", severity: "critical", detail: "0xC0000005" },
    { code: "faultingModule", severity: "warning", detail: "nvldum.dll" },
  ],
  gameLogs: [
    {
      name: "python.log",
      path: "D:/Games/World of Warships/profile/python.log",
      sizeBytes: 1024,
      modified: "2026-10-28T09:59:00Z",
      tail: "12:00:00 INFO: port loaded\n13:00:00 ERROR: failed to load texture",
      highlights: ["13:00:00 ERROR: failed to load texture"],
    },
  ],
  appLogs: [],
  modsInventory: [{ name: "gui", isDir: true, modified: undefined }],
  suspects: [
    { name: "suspect_mod", evidence: "logMention", logLines: ["ERROR res_mods/123/suspect_mod"] },
  ],
  currentBuild: "13187581",
  generatedAt: "2026-10-28T10:01:00Z",
};

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

describe("CrashSection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocked.list.mockResolvedValue([]);
  });

  it("renders the empty state when no crashes were retained", async () => {
    mocked.list.mockResolvedValue([]);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__empty").exists()).toBe(true);
    });
    expect(wrapper.text()).toContain(t("crash.section.noCrashes"));
  });

  it("shows only the latest crash stamp at the top level", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    // Wait for the history load: the open-records button only renders once
    // a record exists.
    let openBtn: ReturnType<typeof wrapper.findAll>[number] | undefined;
    await vi.waitFor(() => {
      openBtn = wrapper
        .findAll("button")
        .find((b) => b.text().includes(t("crash.section.openRecords")));
      expect(openBtn).toBeTruthy();
    });
    // The stamp renders (the exact localized format is locale-dependent):
    expect(wrapper.find(".crash-section__latest-value").text().length).toBeGreaterThan(0);
    // The record list itself lives in the secondary window, not inline.
    expect(wrapper.find(".crash-section__records").exists()).toBe(false);
    await openBtn!.trigger("click");
    // The modal teleports to body — query the document, not the wrapper.
    await vi.waitFor(() => {
      expect(document.body.querySelector(".crash-section__records")).toBeTruthy();
    });
  });

  /** Open the suspect window (the actionable rows live there). */
  async function openSuspects(wrapper: ReturnType<typeof mount>) {
    await vi.waitFor(() => {
      expect(
        wrapper.findAll("button").some((b) => b.text().includes(t("crash.section.suspects"))),
      ).toBe(true);
    });
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes(t("crash.section.suspects")))!
      .trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelector(".crash-section__suspect-actions")).toBeTruthy();
    });
    return document.body.querySelector(".crash-section__suspect-actions") as HTMLElement;
  }

  it("renders findings inline and the suspect actions right-aligned in the window", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__finding").exists()).toBe(true);
    });
    expect(wrapper.text()).toContain("nvldum.dll");
    expect(wrapper.find(".crash-section__finding").text()).toContain(t("crash.severity.critical"));
    const actions = await openSuspects(wrapper);
    const texts = [...actions.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(texts).toContain(t("crash.suspects.quarantine"));
    expect(texts).toContain(t("crash.suspects.delete"));
    expect(texts).toContain(t("crash.suspects.ignore"));
  });

  it("asks before deleting and calls the delete command", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.deleteEntry.mockResolvedValue(null as never);
    const wrapper = mount(CrashSection);
    const actions = await openSuspects(wrapper);
    const del = [...actions.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(t("crash.suspects.delete")),
    );
    del!.click();
    // The confirmation dialog teleports to body.
    await vi.waitFor(() => {
      const buttons = document.body.querySelectorAll("button");
      expect(
        [...buttons].some((b) => b.textContent?.includes(t("crash.suspects.delete"))),
      ).toBe(true);
    });
  });

  it("opens a hikari log window from its card and marks the record viewed", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.markViewed.mockResolvedValue([record({ status: "dismissed" })] as never);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(
        wrapper.findAll("button").some((b) => b.text().includes(t("crash.section.openRecords"))),
      ).toBe(true);
    });
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes(t("crash.section.openRecords")))!
      .trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelector(".crash-section__record")).toBeTruthy();
    });
    (document.body.querySelector(".crash-section__record") as HTMLElement).click();
    // The detail window is hikari's HkLogWindow (tabbed log viewer).
    await vi.waitFor(() => {
      expect(document.body.querySelector(".s-log-viewer")).toBeTruthy();
    });
    // Opening the record retires it (the read watermark).
    await vi.waitFor(() => {
      expect(mocked.markViewed).toHaveBeenCalledWith("crash-1");
    });
    // The per-log tab renders and carries the log's tail.
    const tabs = [...document.body.querySelectorAll<HTMLButtonElement>(".s-log-tab")];
    expect(tabs.some((b) => (b.textContent ?? "").includes("python.log"))).toBe(true);
    tabs.find((b) => (b.textContent ?? "").includes("python.log"))!.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("failed to load texture");
    });
  });

  it("marks the newest pending record viewed when the section mounts", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mount(CrashSection);
    await vi.waitFor(() => {
      expect(mocked.markViewed).toHaveBeenCalledWith("crash-1");
    });
  });

  it("does not auto-mark a crash that arrives while the section is open", async () => {
    mocked.list.mockResolvedValue([record({ status: "dismissed" })]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(
        wrapper.findAll("button").some((b) => b.text().includes(t("crash.section.openRecords"))),
      ).toBe(true);
    });
    expect(mocked.markViewed).not.toHaveBeenCalled();
    // A fresh crash lands mid-session: the sticky prompt IS the
    // notification, so the merely-open section must not retire it —
    // only an explicit view (toast action, record open, row button)
    // marks. The section's selected-record watch refreshes analysis but
    // never marks.
    const crash = useCrashStore();
    crash.history = [record({ id: "fresh" }), ...crash.history];
    await nextTick();
    expect(mocked.markViewed).not.toHaveBeenCalled();
  });

  it("does not mark anything when the history is settled", async () => {
    mocked.list.mockResolvedValue([record({ status: "dismissed" })]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    // The history loaded (the open-records affordance needs a record).
    await vi.waitFor(() => {
      expect(
        wrapper.findAll("button").some((b) => b.text().includes(t("crash.section.openRecords"))),
      ).toBe(true);
    });
    expect(mocked.markViewed).not.toHaveBeenCalled();
  });

  it("marks a record viewed from its list row without opening the detail", async () => {
    mocked.list.mockResolvedValue([
      record(),
      record({ id: "older", status: "new", detectedAt: "2026-10-27T10:00:00Z" }),
    ]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.markViewed.mockResolvedValue([] as never);
    const wrapper = mount(CrashSection);
    await openRecords(wrapper);
    // Both pending rows carry the explicit action.
    const markButtons = [
      ...document.body.querySelectorAll<HTMLButtonElement>(".crash-section__record button"),
    ].filter((b) => (b.textContent ?? "").includes(t("crash.section.markViewed")));
    expect(markButtons).toHaveLength(2);
    markButtons[1]!.click();
    await vi.waitFor(() => {
      expect(mocked.markViewed).toHaveBeenCalledWith("older");
    });
    // The action must not double as an open: the detail window stays down.
    expect(document.body.querySelector(".s-log-viewer")).toBeFalsy();
  });

  it("ignores a suspect through the store command", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.ignore.mockResolvedValue(null as never);
    const wrapper = mount(CrashSection);
    const actions = await openSuspects(wrapper);
    const ignoreBtn = [...actions.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(t("crash.suspects.ignore")),
    );
    ignoreBtn!.click();
    await vi.waitFor(() => {
      expect(mocked.ignore).toHaveBeenCalledWith("suspect_mod");
    });
  });

  it("quarantines every pending suspect from the footer bulk action", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.quarantineMod.mockResolvedValue([]);
    const wrapper = mount(CrashSection);
    await openSuspects(wrapper);
    const bulk = bulkButton();
    expect(bulk).toBeTruthy();
    expect(bulk!.disabled).toBe(false);
    bulk!.click();
    await vi.waitFor(() => {
      expect(mocked.quarantineMod).toHaveBeenCalledWith(
        "D:/Games/World of Warships",
        "suspect_mod",
        "crash-1",
      );
    });
  });

  it("disables the bulk action once every suspect is quarantined", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.listQuarantined.mockResolvedValue([
      { name: "suspect_mod", quarantinedAt: "2026-10-28T10:02:00Z" },
    ]);
    mocked.quarantineMod.mockResolvedValue([]);
    const wrapper = mount(CrashSection);
    await openSuspects(wrapper);
    const bulk = bulkButton();
    expect(bulk).toBeTruthy();
    expect(bulk!.disabled).toBe(true);
    expect(mocked.quarantineMod).not.toHaveBeenCalled();
  });

  it("exports the selected record through the store", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.exportReport.mockResolvedValue("C:/crash-reports/x.zip");
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__actions").exists()).toBe(true);
    });
    const exportBtn = wrapper
      .find(".crash-section__actions")
      .findAll("button")
      .find((b) => b.text().includes(t("crash.section.export")));
    expect(exportBtn).toBeTruthy();
    await exportBtn!.trigger("click");
    await vi.waitFor(() => {
      expect(mocked.exportReport).toHaveBeenCalledWith("crash-1");
    });
  });

  /** Click the "Safe mode & restart" recovery button. */
  async function clickSafeRestart(wrapper: ReturnType<typeof mount>) {
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__actions").exists()).toBe(true);
    });
    const btn = wrapper
      .find(".crash-section__actions")
      .findAll("button")
      .find((b) => b.text().includes(t("crash.toast.safeRestart")));
    expect(btn).toBeTruthy();
    await btn!.trigger("click");
  }

  it("safe-mode restart uses the active install when the record has no root", async () => {
    // An event-log/backfill record carries no gameRoot; the section's
    // effective install is the active selection. Isolation must target
    // that install, then the relaunch must reuse it.
    useConfigStore().activeInstall = { kind: "manual", path: ACTIVE };
    mocked.list.mockResolvedValue([record({ gameRoot: null })]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    await clickSafeRestart(wrapper);
    await vi.waitFor(() => {
      expect(mocked.safeMode).toHaveBeenCalledWith(ACTIVE, true);
    });
    expect(mocked.restart).toHaveBeenCalledWith(ACTIVE);
    // Isolation first, relaunch second.
    expect(mocked.safeMode.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.restart.mock.invocationCallOrder[0]!,
    );
  });

  it("refuses the safe-mode restart when no install can be resolved", async () => {
    // No record root and no active install: nothing can be isolated, so
    // neither safe mode nor the relaunch may fire — the refusal toast is
    // the only outcome.
    mocked.list.mockResolvedValue([record({ gameRoot: null })]);
    mocked.analyze.mockResolvedValue(analysis);
    const toast = useToast();
    toast.toasts.splice(0, toast.toasts.length);
    const wrapper = mount(CrashSection);
    await clickSafeRestart(wrapper);
    await vi.waitFor(() => {
      expect(
        toast.toasts.some((s) =>
          s.messages.some((m) => m.text === t("crash.toast.safeRestartNoRoot")),
        ),
      ).toBe(true);
    });
    expect(mocked.safeMode).not.toHaveBeenCalled();
    expect(mocked.restart).not.toHaveBeenCalled();
  });

  /** Open the records window (the reset action lives in its footer). */
  async function openRecords(wrapper: ReturnType<typeof mount>) {
    await vi.waitFor(() => {
      expect(
        wrapper.findAll("button").some((b) => b.text().includes(t("crash.section.openRecords"))),
      ).toBe(true);
    });
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes(t("crash.section.openRecords")))!
      .trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelector(".crash-section__records")).toBeTruthy();
    });
  }

  it("resets every pending record from the records window footer", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.dismissAll.mockResolvedValue(1 as never);
    const wrapper = mount(CrashSection);
    await openRecords(wrapper);
    const reset = resetButton();
    expect(reset).toBeTruthy();
    // A pending (new) record exists — the reset is armed.
    expect(reset!.disabled).toBe(false);
    reset!.click();
    await vi.waitFor(() => {
      expect(mocked.dismissAll).toHaveBeenCalledOnce();
    });
  });

  it("disables the reset once no pending record remains", async () => {
    mocked.list.mockResolvedValue([record({ status: "dismissed" })]);
    const wrapper = mount(CrashSection);
    await openRecords(wrapper);
    const reset = resetButton();
    expect(reset).toBeTruthy();
    expect(reset!.disabled).toBe(true);
    expect(mocked.dismissAll).not.toHaveBeenCalled();
  });

  it("renders the safeguard switch row", async () => {
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__safeguard").exists()).toBe(true);
    });
    expect(wrapper.text()).toContain(t("crash.safeguard.title"));
    // Parsing recent crashes is automatic — no manual scan button.
    expect(wrapper.text()).not.toContain(t("crash.safeguard.scan"));
  });
});
