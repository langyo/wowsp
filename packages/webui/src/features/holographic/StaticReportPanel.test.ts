/**
 * StaticReportPanel tests — the pure formatters the long image shares with
 * the live panel, plus the DOM-node → PNG-bytes capture contract the modal's
 * copy action drives (clipboard + toast live in the shared share kit).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, watchEffect } from "vue";
import { toBlob } from "html-to-image";

import type { StaticReport } from "@/api";
import StaticReportPanel, {
  captureReportPng,
  coverageClass,
  formatHp,
  sectorLabel,
} from "./StaticReportPanel";

vi.mock("html-to-image", () => ({ toBlob: vi.fn() }));

describe("formatHp", () => {
  it("compacts damage values", () => {
    expect(formatHp(999)).toBe("999");
    expect(formatHp(84_200)).toBe("84.2k");
    expect(formatHp(1_310_000)).toBe("1.31M");
  });
});

describe("sectorLabel", () => {
  it("maps sectors to relative bearings and 16 to held", () => {
    // The i18n stub: the test locale resolves the held key verbatim.
    expect(sectorLabel(0)).toBe("0°");
    expect(sectorLabel(2)).toBe("45°");
    expect(sectorLabel(8)).toBe("180°");
    expect(sectorLabel(15)).toBe("338°");
    expect(sectorLabel(16)).toBeTruthy(); // localized "held"
  });
});

describe("coverageClass", () => {
  it("badges none / partial / full", () => {
    expect(coverageClass({ samples: 0, completeness: 0 })).toBe("none");
    expect(coverageClass({ samples: 40, completeness: 0.43 })).toBe("partial");
    expect(coverageClass({ samples: 97, completeness: 0.95 })).toBe("full");
  });
});

describe("captureReportPng", () => {
  beforeEach(() => {
    vi.mocked(toBlob).mockReset();
  });

  it("renders the export column at 2x into the PNG bytes the clipboard takes", async () => {
    const node = document.createElement("div");
    // The long image must capture the FULL column, not the scroll viewport:
    // the height handed to the renderer is the node's scrollHeight.
    Object.defineProperty(node, "scrollHeight", { value: 4321 });
    const bytes = new Uint8Array([9, 8, 7]);
    vi.mocked(toBlob).mockResolvedValue(new Blob([bytes], { type: "image/png" }));

    await expect(captureReportPng(node)).resolves.toEqual(bytes);
    expect(toBlob).toHaveBeenCalledWith(
      node,
      expect.objectContaining({
        backgroundColor: "#0d1117",
        height: 4321,
        pixelRatio: 2,
        skipFonts: true,
        style: { maxHeight: "none", overflow: "visible" },
      }),
    );
  });

  it("rejects when the renderer hands back no PNG", async () => {
    vi.mocked(toBlob).mockResolvedValue(null);
    await expect(captureReportPng(document.createElement("div"))).rejects.toThrow(/no PNG/);
  });

  it("propagates a renderer failure so the copy toast can report it", async () => {
    vi.mocked(toBlob).mockRejectedValue(new Error("svg render boom"));
    await expect(captureReportPng(document.createElement("div"))).rejects.toThrow(
      "svg render boom",
    );
  });
});

/** The smallest report the column can render (one roster entry, one sample,
 *  no moments) — enough to mount the REAL panel for the ref wiring. */
// Typed end to end (no double cast — the type-escape ratchet counts them):
// every field of StaticReport is constructible here.
const minimalReport: StaticReport = {
  replayPath: "replays/20261106_1.wowsreplay",
  replayId: "20261106_1",
  mapName: "spaces/15_NE_north",
  gameMode: "Domination",
  durationS: 600,
  losLoaded: false,
  modelSources: { fire: "models/fire.onnx", moveModel: "models/move.onnx" },
  entityId: 1,
  roster: [
    {
      entityId: 1,
      shipId: 3541776848,
      name: "me",
      playerName: "me",
      teamId: 0,
      isRecorder: true,
      diedAt: null,
      coverage: {
        aliveFrom: 0,
        aliveTo: 600,
        samples: 10,
        gapSeconds: 0,
        completeness: 1,
        gapSegments: [],
      },
      whole: {
        wholeGame: 0.5,
        wholeFire: 0.5,
        wholeMove: 0.5,
        contribution: 1000,
        contributionShots: 2,
      },
      outcome: null,
    },
  ],
  timeline: [{ t: 0, inst: 0.5, confidence: 0.9 }],
  moments: [],
};

describe("exposed capturePng", () => {
  it("captures the panel's own export root through the component-ref plumbing", async () => {
    vi.mocked(toBlob).mockReset();
    const bytes = new Uint8Array([4, 5, 6]);
    vi.mocked(toBlob).mockResolvedValue(new Blob([bytes], { type: "image/png" }));

    // The SAME component-ref plumbing StaticReportModal uses: the host
    // panelRef receives the panel's exposed handle, never its internals.
    let handle: { capturePng: () => Promise<Uint8Array> } | null = null;
    const Host = defineComponent({
      name: "StaticReportPanelHost",
      setup() {
        const panelRef = ref<{ capturePng: () => Promise<Uint8Array> } | null>(null);
        watchEffect(() => {
          handle = panelRef.value;
        });
        return () =>
          h(StaticReportPanel, {
            ref: panelRef,
            report: minimalReport,
            onPick: () => {},
          });
      },
    });
    mount(Host);
    await nextTick();

    expect(handle).not.toBeNull();
    await expect(handle!.capturePng()).resolves.toEqual(bytes);
    // The capture targets the column's export root — not some other node.
    const node = vi.mocked(toBlob).mock.calls[0][0] as HTMLElement;
    expect(node.classList.contains("static-report-panel__export-root")).toBe(true);
  });
});
