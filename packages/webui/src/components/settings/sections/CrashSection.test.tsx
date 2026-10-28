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
  },
}));

import { api } from "@/api";
import CrashSection from "./CrashSection";

const mocked = {
  list: vi.mocked(api.listGameCrashes),
  analyze: vi.mocked(api.analyzeGameCrash),
  exportReport: vi.mocked(api.exportGameCrashReport),
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
  });

  it("renders the empty state when no crashes were retained", async () => {
    mocked.list.mockResolvedValue([]);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__empty").exists()).toBe(true);
    });
    expect(wrapper.text()).toContain(t("crash.section.empty"));
  });

  it("lists records and renders findings with severity chips", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__record").exists()).toBe(true);
    });
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__finding").exists()).toBe(true);
    });
    const text = wrapper.text();
    expect(text).toContain("WorldOfWarships64.exe");
    expect(text).toContain("nvldum.dll");
    expect(wrapper.find(".crash-section__chip--critical").exists()).toBe(true);
  });

  it("renders suspects with the quarantine action", async () => {
    mocked.list.mockResolvedValue([record()]);
    mocked.analyze.mockResolvedValue(analysis);
    const wrapper = mount(CrashSection);
    await vi.waitFor(() => {
      expect(wrapper.find(".crash-section__suspect").exists()).toBe(true);
    });
    expect(wrapper.text()).toContain("suspect_mod");
    expect(wrapper.text()).toContain(t("crash.suspects.quarantine"));
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
      .findAll("button")
      .find((b) => b.text().includes(t("crash.section.export")));
    expect(exportBtn).toBeTruthy();
    await exportBtn!.trigger("click");
    await vi.waitFor(() => {
      expect(mocked.exportReport).toHaveBeenCalledWith("crash-1");
    });
  });
});