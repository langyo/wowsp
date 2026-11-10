/**
 * Settings → Resources ai channel state: the manifest check and the install
 * pass are the two network-touching actions on the model card, so the hook's
 * gating (ai build only, single-flight, progress tracking, error flag) is
 * pinned here instead of through the rendered section.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { api } from "@/api";
import { useSettingsResourcesState } from "@/components/settings/useSettingsResourcesState";

vi.mock("@/api", () => ({
  api: {
    decisionsPackStatus: vi.fn(),
    clearDecisionsPack: vi.fn(),
    aiPackStatus: vi.fn(),
    aiPackCheck: vi.fn(),
    aiPackDownload: vi.fn(),
    aiPackCancel: vi.fn(),
    listenDownloadProgress: vi.fn(() => () => undefined),
  },
}));

const packStatus = {
  installed: true,
  seq: 2,
  version: "2026-11-10T00:00:00Z",
  treeSha256: "a".repeat(64),
  revision: "b".repeat(40),
  installedAt: "2026-11-10T00:00:00Z",
  sizeBytes: 4096,
  losMaps: 3,
  // The inventory reports both torpedo slots: the current T4 three-head
  // model (absent in this older pack) and the legacy two-head fallback.
  models: [
    { path: "torpedo4_model.onnx", present: false, sizeBytes: 0 },
    { path: "torpedo_model.onnx", present: true, sizeBytes: 492411 },
  ],
};

const checkResult = {
  current: packStatus,
  latestSeq: 3,
  latestVersion: "2026-11-11T00:00:00Z",
  latestTreeSha256: "c".repeat(64),
  latestRevision: "d".repeat(40),
  totalBytes: 8192,
  losIncluded: true,
  files: [{ path: "fire_model.onnx", size: 8192, sha256: "e".repeat(64) }],
  endpoint: "https://hf-mirror.com",
  manifestSha256: "f".repeat(64),
  checkedAt: "2026-11-11T00:00:00Z",
  updateAvailable: true,
};

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.decisionsPackStatus).mockResolvedValue({
    present: true,
    dir: "/tmp/decisions",
    sizeBytes: 4096,
  } as never);
  vi.mocked(api.aiPackStatus).mockResolvedValue(packStatus as never);
  vi.mocked(api.aiPackCheck).mockResolvedValue(checkResult as never);
  vi.mocked(api.aiPackDownload).mockResolvedValue(null as never);
  vi.mocked(api.aiPackCancel).mockResolvedValue(null as never);
});

function hook() {
  const state = useSettingsResourcesState();
  state.capabilities.loaded = true;
  state.capabilities.aiInference = true;
  return state;
}

describe("settings resources ai channel", () => {
  it("reads the local stamp and the authenticated manifest", async () => {
    const state = hook();
    await state.refreshDecisions();
    expect(state.aiStatus.value?.seq).toBe(2);
    // Both torpedo slots ride the status inventory (T4 current + legacy).
    const slots = state.aiStatus.value?.models ?? [];
    expect(slots.some((m) => m.path === "torpedo4_model.onnx")).toBe(true);
    expect(slots.some((m) => m.path === "torpedo_model.onnx")).toBe(true);
    await state.checkAiUpdate();
    expect(state.aiCheck.value?.latestSeq).toBe(3);
    expect(state.aiCheck.value?.updateAvailable).toBe(true);
    // The check primes the daily TTL.
    expect(window.localStorage.getItem("wowsp.aiPack.lastCheck")).not.toBeNull();
  });

  it("runs the install pass once and refreshes the local state", async () => {
    const state = hook();
    await state.downloadAi();
    expect(api.aiPackDownload).toHaveBeenCalledTimes(1);
    expect(api.aiPackCheck).toHaveBeenCalled(); // post-install re-check
    expect(state.aiDownloading.value).toBe(false);
    expect(state.aiError.value).toBe(false);
  });

  it("records a failed check without throwing", async () => {
    const state = hook();
    vi.mocked(api.aiPackCheck).mockRejectedValueOnce(new Error("offline"));
    await state.checkAiUpdate();
    expect(state.aiError.value).toBe(true);
    expect(state.aiCheck.value).toBeNull();
  });

  it("skips the network in a build without ai inference", async () => {
    const state = useSettingsResourcesState();
    state.capabilities.loaded = true;
    state.capabilities.aiInference = false;
    await state.checkAiUpdate();
    expect(api.aiPackCheck).not.toHaveBeenCalled();
  });
});
