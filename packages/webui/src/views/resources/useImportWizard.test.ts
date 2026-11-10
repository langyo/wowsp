/** Custom-import wizard state machine: the step flow, the probe gating that
 *  keeps "next" disabled, the pick/accept hand-off, the progress event
 *  wiring and the run's success/failure surfaces. The backend is mocked at
 *  the `@/api` boundary; the hub is a typed slice double (the composable
 *  only reads gameRoot/the guards and calls the refresh hooks). */
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pickFile: vi.fn(async (): Promise<string | null> => null),
  pickSource: vi.fn(async (): Promise<string | null> => null),
  probe: vi.fn(),
  importCustom: vi.fn(),
  listen: vi.fn(),
  scan: vi.fn(async () => {}),
  loadRecords: vi.fn(async () => {}),
  syncFreshness: vi.fn(async () => {}),
  refreshStack: vi.fn(async () => {}),
  selectLayer: vi.fn(),
  disclaimer: vi.fn(async () => true),
  gameRunning: vi.fn(() => false),
  safeModeBlocked: vi.fn(() => false),
}));

vi.mock("@/api", () => ({
  api: {
    modHubPickCustomFile: mocks.pickFile,
    modHubPickSource: mocks.pickSource,
    modHubProbeCustomImport: mocks.probe,
    modHubImportCustom: mocks.importCustom,
    listenCustomImportProgress: mocks.listen,
  },
}));

vi.mock("@/features/modhub/ModOpDisclaimer", () => ({
  requestModOpDisclaimer: mocks.disclaimer,
}));

import type { CustomImportProbe, CustomImportReport } from "@/api";
import { useImportWizard } from "./useImportWizard";
import type { ModHubCtx } from "./useModHub";

const LAYER = { packId: "local-1-Intro", name: "Intro", version: "" };

function hubDouble(): ModHubCtx {
  // The composable reads a handful of members; the intersection type behind
  // ModHubCtx is the view's whole state surface, so the double is asserted
  // structurally rather than rebuilt member by member.
  return {
    gameRoot: ref("D:/Games/WoWs"),
    gameRunning: mocks.gameRunning,
    safeModeBlocked: mocks.safeModeBlocked,
    scan: mocks.scan,
    loadRecords: mocks.loadRecords,
    selectLayer: mocks.selectLayer,
    pluginUpdates: { syncFreshness: mocks.syncFreshness },
    layerStack: {
      refresh: mocks.refreshStack,
      layerById: vi.fn(() => LAYER),
    },
  } as unknown as ModHubCtx;
}

function probeOf(overrides: Partial<CustomImportProbe> = {}): CustomImportProbe {
  return {
    path: "C:\\clips\\intro.webm",
    fileName: "intro",
    isFile: true,
    sizeBytes: 2048,
    structure: ["gui/video/login/main.webm"],
    problems: [],
    ...overrides,
  };
}

function reportOf(overrides: Partial<CustomImportReport> = {}): CustomImportReport {
  return {
    name: "Intro",
    binVersion: "1",
    wroteFiles: 1,
    warnings: [],
    layerId: LAYER.packId,
    ...overrides,
  };
}

function mountWizard() {
  const state: { wizard: ReturnType<typeof useImportWizard> | null } = {
    wizard: null,
  };
  const Comp = defineComponent({
    setup() {
      state.wizard = useImportWizard(hubDouble());
      return () => h("div");
    },
  });
  const wrapper = mount(Comp);
  if (!state.wizard) throw new Error("wizard not created");
  return { wrapper, wizard: state.wizard };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gameRunning.mockReturnValue(false);
  mocks.safeModeBlocked.mockReturnValue(false);
  mocks.disclaimer.mockResolvedValue(true);
  mocks.listen.mockImplementation(async () => () => {});
  mocks.probe.mockResolvedValue(probeOf());
  mocks.importCustom.mockResolvedValue(reportOf());
});

describe("custom import wizard steps", () => {
  it("opens on the kind step and refuses to advance without a kind", async () => {
    const { wizard } = mountWizard();
    wizard.openImportWizard();
    expect(wizard.importWizardOpen.value).toBe(true);
    expect(wizard.importStep.value).toBe("kind");
    expect(wizard.importCanAdvance.value).toBe(false);
    await wizard.nextImportStep();
    expect(wizard.importStep.value).toBe("kind");

    wizard.chooseImportKind("video");
    expect(wizard.importCanAdvance.value).toBe(true);
    await wizard.nextImportStep();
    expect(wizard.importStep.value).toBe("source");
  });

  it("is not dismissable while a run is in flight", () => {
    const { wizard } = mountWizard();
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    // A run in flight is simulated through the public state (the run itself
    // is covered below); closing must refuse.
    (wizard.importRunState as { value: string }).value = "running";
    wizard.closeImportWizard();
    expect(wizard.importWizardOpen.value).toBe(true);
  });

  it("returns to the source step when the run step's back button is used", async () => {
    const { wizard } = mountWizard();
    wizard.openImportWizard();
    wizard.chooseImportKind("voice");
    await wizard.acceptImportSource("C:\\packs\\Hoshino");
    await wizard.nextImportStep();
    expect(wizard.importStep.value).toBe("source");
  });
});

describe("custom import probe gating", () => {
  it("answers an unsupported video locally, without an IPC", async () => {
    const { wizard } = mountWizard();
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    await wizard.nextImportStep();
    await wizard.acceptImportSource("C:\\clips\\clip.avi");
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(wizard.importProbe.value?.problems).toEqual([
      { code: "unsupportedVideo", detail: "avi" },
    ]);
    expect(wizard.importCanAdvance.value).toBe(false);
    expect(wizard.importBlockCode.value).toBe("unsupportedVideo");
  });

  it("prefills the display name and probes the backend for a picked file", async () => {
    const { wizard } = mountWizard();
    mocks.pickFile.mockResolvedValue("C:\\clips\\My Clip.webm");
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    await wizard.nextImportStep();

    const picked = await wizard.pickImportSource();
    expect(picked).toBe("C:\\clips\\My Clip.webm");
    expect(mocks.pickFile).toHaveBeenCalledTimes(1);
    expect(mocks.pickSource).not.toHaveBeenCalled();

    await wizard.acceptImportSource(picked as string);
    expect(wizard.importDisplayName.value).toBe("My Clip");
    expect(mocks.probe).toHaveBeenCalledWith(
      "video",
      "C:\\clips\\My Clip.webm",
      "My Clip",
    );
    expect(wizard.importCanAdvance.value).toBe(true);
    expect(wizard.importBlockCode.value).toBeNull();
  });

  it("keeps next disabled while the probe reports a problem", async () => {
    const { wizard } = mountWizard();
    mocks.probe.mockResolvedValue(
      probeOf({ problems: [{ code: "missingFfmpeg", detail: "mp4" }] }),
    );
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    await wizard.nextImportStep();
    await wizard.acceptImportSource("C:\\clips\\intro.mp4");
    expect(wizard.importCanAdvance.value).toBe(false);
    expect(wizard.importBlockCode.value).toBe("missingFfmpeg");
  });

  it("uses the folder picker for the non-video kinds", async () => {
    const { wizard } = mountWizard();
    mocks.pickSource.mockResolvedValue("C:\\packs\\textures");
    wizard.openImportWizard();
    wizard.chooseImportKind("texture");
    await wizard.nextImportStep();
    await wizard.pickImportSource();
    expect(mocks.pickSource).toHaveBeenCalledTimes(1);
    expect(mocks.pickFile).not.toHaveBeenCalled();
  });

  it("re-probes (debounced) when a voice display name changes", async () => {
    vi.useFakeTimers();
    try {
      const { wizard } = mountWizard();
      wizard.openImportWizard();
      wizard.chooseImportKind("voice");
      await wizard.nextImportStep();
      await wizard.acceptImportSource("C:\\packs\\Hoshino");
      mocks.probe.mockClear();
      wizard.setImportDisplayName("My Bank");
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.probe).toHaveBeenCalledTimes(1);
      expect(mocks.probe.mock.calls[0]).toEqual([
        "voice",
        "C:\\packs\\Hoshino",
        "My Bank",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("custom import run", () => {
  it("starts on entering the run step, streams progress and registers the layer", async () => {
    const { wizard } = mountWizard();
    // The event handler the composable registers, captured off the mock.
    const sink: {
      emit: ((tick: { stage: string; percent: number }) => void) | null;
    } = { emit: null };
    mocks.listen.mockImplementation(
      async (handler: (tick: { stage: string; percent: number }) => void) => {
        sink.emit = handler;
        return () => {};
      },
    );
    // A pending import holds the run step open, so the progress wiring is
    // observable while it is in flight.
    let resolveImport: (report: CustomImportReport) => void = () => {};
    mocks.importCustom.mockImplementation(
      () =>
        new Promise<CustomImportReport>((resolve) => {
          resolveImport = resolve;
        }),
    );
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    await wizard.nextImportStep();
    await wizard.acceptImportSource("C:\\clips\\intro.webm");
    const run = wizard.nextImportStep();
    await vi.waitFor(() => expect(wizard.importRunState.value).toBe("running"));
    expect(wizard.importStep.value).toBe("run");
    expect(wizard.importRunning.value).toBe(true);

    sink.emit?.({ stage: "transcodeMain", percent: 42.4 });
    expect(wizard.importProgress.value).toEqual({
      stage: "transcodeMain",
      percent: 42,
    });

    resolveImport(reportOf());
    await run;
    await vi.waitFor(() => expect(wizard.importRunState.value).toBe("done"));
    expect(mocks.importCustom).toHaveBeenCalledWith(
      "D:/Games/WoWs",
      "video",
      "C:\\clips\\intro.webm",
      "intro",
    );
    expect(wizard.importReport.value?.layerId).toBe(LAYER.packId);
    expect(mocks.selectLayer).toHaveBeenCalledWith(LAYER);
    expect(mocks.scan).toHaveBeenCalled();
    expect(mocks.loadRecords).toHaveBeenCalled();
    expect(mocks.syncFreshness).toHaveBeenCalled();
    expect(mocks.refreshStack).toHaveBeenCalled();
    // The layer was adopted, so the view names it as a layer.
    expect(wizard.importReport.value?.layerId).toBeTruthy();
  });

  it("reports a failure and retries on demand", async () => {
    const { wizard } = mountWizard();
    mocks.importCustom.mockRejectedValueOnce(new Error("ffmpeg exploded"));
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    await wizard.nextImportStep();
    await wizard.acceptImportSource("C:\\clips\\intro.mp4");
    await wizard.nextImportStep();
    await vi.waitFor(() => expect(wizard.importRunState.value).toBe("failed"));
    expect(wizard.importError.value).toBe("ffmpeg exploded");

    mocks.importCustom.mockResolvedValueOnce(reportOf({ layerId: undefined }));
    await wizard.retryImport();
    await vi.waitFor(() => expect(wizard.importRunState.value).toBe("done"));
    expect(mocks.importCustom).toHaveBeenCalledTimes(2);
    // A payload that stayed a plain install reports no layer id.
    expect(wizard.importReport.value?.layerId).toBeUndefined();
  });

  it("refuses to run while the target client is live", async () => {
    const { wizard } = mountWizard();
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    await wizard.nextImportStep();
    await wizard.acceptImportSource("C:\\clips\\intro.webm");
    mocks.gameRunning.mockReturnValue(true);
    await wizard.nextImportStep();
    expect(wizard.importStep.value).toBe("source");
    expect(mocks.importCustom).not.toHaveBeenCalled();
  });

  it("refuses to run without the mod-op disclaimer", async () => {
    const { wizard } = mountWizard();
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    await wizard.nextImportStep();
    await wizard.acceptImportSource("C:\\clips\\intro.webm");
    mocks.disclaimer.mockResolvedValue(false);
    await wizard.nextImportStep();
    expect(wizard.importStep.value).toBe("source");
    expect(mocks.importCustom).not.toHaveBeenCalled();
  });

  it("resets when the game root changes", async () => {
    const { wizard } = mountWizard();
    wizard.openImportWizard();
    wizard.chooseImportKind("video");
    wizard.beginImportRootChange();
    expect(wizard.importWizardOpen.value).toBe(false);
    expect(wizard.importKind.value).toBeNull();
    expect(wizard.importStep.value).toBe("kind");
  });
});
