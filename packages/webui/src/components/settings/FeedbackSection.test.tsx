/**
 * Tests for the settings' 问题反馈 pane's export consent dialog.
 *
 * The full export sweeps identifying hardware data (serials, MACs, …), so
 * the dialog must never make it the default: "logs only" is the primary
 * action, the full export an explicit secondary choice, and Cancel closes
 * the dialog without exporting anything.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { RPC } from "@/rpc";
import { t } from "@/i18n";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/transport", () => ({ transport: { invoke: mocks.invoke }, isTauri: () => false }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.6.0") }));

import FeedbackSection from "./FeedbackSection";

enableAutoUnmount(afterEach);

const OVERVIEW = {
  dir: "%APPDATA%/WoWSP/logs",
  latest: {
    name: "wowsp.2026-10-14.log",
    path: "%APPDATA%/WoWSP/logs/wowsp.2026-10-14.log",
    sizeBytes: 2048,
    modified: "2026-10-14T03:00:00Z",
  },
  files: [],
  totalBytes: 2048,
  retainedMax: 14,
};

beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation((cmd: string) => {
    if (cmd === RPC.logs_overview) return Promise.resolve(OVERVIEW);
    if (cmd === RPC.logs_export_bundle) return Promise.resolve("bundle.zip");
    return Promise.resolve(null);
  });
  document.body.innerHTML = "";
});

async function openConsentDialog() {
  const wrapper = mount(FeedbackSection, {
    attachTo: document.body,
    global: { plugins: [createPinia()] },
  });
  await flushPromises();
  const exportButton = wrapper
    .findAll("button")
    .find((b) => b.text().includes(t("settings.feedbackExport")));
  if (!exportButton) throw new Error("export button not rendered");
  await exportButton.trigger("click");
  await flushPromises();
  return wrapper;
}

/** HkModal teleports its footer to body. */
function footerButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button"));
}

function footerButton(label: string): HTMLButtonElement {
  const btn = footerButtons().find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`footer button "${label}" not rendered`);
  return btn;
}

const exportCalls = () =>
  mocks.invoke.mock.calls.filter(([cmd]) => cmd === RPC.logs_export_bundle);

describe("FeedbackSection export consent dialog", () => {
  it("lists every identifying hardware category and the log redaction note", async () => {
    await openConsentDialog();
    const text = document.body.textContent ?? "";
    for (const key of [
      "settings.feedbackHwItemSerial",
      "settings.feedbackHwItemVolumes",
      "settings.feedbackHwItemEnv",
      "settings.feedbackHwLogsNote",
    ]) {
      expect(text).toContain(t(key));
    }
  });

  it("makes logs-only the primary action and the full export secondary", async () => {
    await openConsentDialog();
    const primary = footerButtons().filter((b) => b.classList.contains("hk-btn-primary"));
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toContain(t("settings.feedbackHwExportLogs"));
    expect(footerButton(t("settings.feedbackHwExportFull")).classList).not.toContain(
      "hk-btn-primary",
    );

    footerButton(t("settings.feedbackHwExportLogs")).click();
    await flushPromises();
    expect(exportCalls()).toEqual([[RPC.logs_export_bundle, { includeHardware: false }]]);
  });

  it("cancel closes the dialog without exporting", async () => {
    await openConsentDialog();
    footerButton(t("settings.feedbackHwCancel")).click();
    await flushPromises();
    expect(exportCalls()).toHaveLength(0);
  });

  it("the full export still sends includeHardware", async () => {
    await openConsentDialog();
    footerButton(t("settings.feedbackHwExportFull")).click();
    await flushPromises();
    expect(exportCalls()).toEqual([[RPC.logs_export_bundle, { includeHardware: true }]]);
  });
});
