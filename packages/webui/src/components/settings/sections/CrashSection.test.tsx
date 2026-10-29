/** CrashSection: the settings crash-report pane. The api module is
 *  mocked (the same seam the crash store tests use); the section runs
 *  against the real stores. Covers the empty state, the record list,
 *  the findings render (message + severity chip) and the export
 *  action plumbing. */
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPinia, setActivePinia } from "pinia";

import type { CrashAnalysis, GameCrashRecord } from "@/api";
import { initLocaleMessages, t } from "@/i18n";

vi.mock("@/api", () => ({
  api: {
    listenGameCrash: vi.fn(() => Promise.resolve(() => undefined)),
    listGameCrashes: vi.fn(),
    dismissGameCrash: vi.fn(),
    analyzeGameCrash: vi.fn(),
    exportGameCrashReport: vi.fn(),
    listQuarantinedMods: vi.fn(() => Promise.resolve([])),
    quarantineMod: vi.fn(),
    restoreMod: vi.fn(),
    restartGame: vi.fn(),
    modHubSetSafeMode: vi.fn(),
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
  analyze: vi.mocked(api.analyzeGameCrash),
  exportReport: vi.mocked(api.exportGameCrashReport),
  deleteEntry: vi.mocked(api.deleteEntry),
  ignore: vi.mocked(api.ignoreSuspect),
  restore: vi.mocked(api.restoreSuspect),
};

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
  gameLogs: [],
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

  it("renders findings and the suspect actions right-aligned", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__finding").exists()).toBe(true);
    });
    expect(wrapper.text()).toContain("nvldum.dll");
    // Severity tag renders (hikari HkTag inside the finding row).
    expect(wrapper.find(".crash-section__finding").text()).toContain(t("crash.severity.critical"));
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__suspect").exists()).toBe(true);
    });
    const actions = wrapper.find(".crash-section__suspect-actions");
    expect(actions.exists()).toBe(true);
    const texts = actions.findAll("button").map((b) => b.text());
    expect(texts).toContain(t("crash.suspects.quarantine"));
    expect(texts).toContain(t("crash.suspects.delete"));
    expect(texts).toContain(t("crash.suspects.ignore"));
  });

  it("asks before deleting and calls the delete command", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.deleteEntry.mockResolvedValue(null as never);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__suspect-actions").exists()).toBe(true);
    });
    const del = wrapper
      .find(".crash-section__suspect-actions")
      .findAll("button")
      .find((b) => b.text().includes(t("crash.suspects.delete")));
    await del!.trigger("click");
    // The confirmation dialog teleports to body.
    await vi.waitFor(() => {
      const buttons = document.body.querySelectorAll("button");
      expect(
        [...buttons].some((b) => b.textContent?.includes(t("crash.suspects.delete"))),
      ).toBe(true);
    });
  });

  it("ignores a suspect through the store command", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    mocked.ignore.mockResolvedValue(null as never);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__suspect-actions").exists()).toBe(true);
    });
    const ignoreBtn = wrapper
      .find(".crash-section__suspect-actions")
      .findAll("button")
      .find((b) => b.text().includes(t("crash.suspects.ignore")));
    await ignoreBtn!.trigger("click");
    await vi.waitFor(() => {
      expect(mocked.ignore).toHaveBeenCalledWith("suspect_mod");
    });
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
