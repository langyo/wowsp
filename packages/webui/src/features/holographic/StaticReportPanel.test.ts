/**
 * StaticReportPanel tests — the shared formatters, the DOM-node → PNG
 * capture contract the modal's copy action drives, and the panel wiring: the
 * head shows only the selected perspective behind the dropdown, the editor
 * timeline replaces the old card wall, and capture mode renders the static
 * annotation band BEFORE html-to-image clones the node.
 */
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, watchEffect } from "vue";
import { toBlob } from "html-to-image";

import type { StaticMoment, StaticReport } from "@/api";
import StaticReportPanel, { captureReportPng } from "./StaticReportPanel";
import {
  coverageClass,
  formatClock,
  formatDuration,
  formatHp,
  sectorLabel,
} from "./reportFormat";

vi.mock("html-to-image", () => ({ toBlob: vi.fn() }));
// MapNameTag resolves its jump through the router; the sheet test only pins
// its presence in the provenance line.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function moment(overrides: Partial<StaticMoment> = {}): StaticMoment {
  return {
    t: 100,
    category: "damageRealized",
    weight: 1,
    hpFrac: 1,
    speedKt: 18,
    enemiesObserved: 2,
    nearestEnemy: { entityId: 9, distM: 3800, bearingRelRad: 0.2, inRange: true },
    fired: true,
    fireProb: 0.08,
    moveSector: 14,
    advisedSector: 16,
    advisedProb: 0.4,
    inst: 0.08,
    fireAlignment: 0.1,
    moveAlignment: 0.2,
    confidence: 0.62,
    hpLostWindow: 9400,
    hpFracAfter: 0.94,
    ...overrides,
  };
}

/** The smallest report the column can render end to end — one scored
 *  perspective, one unscoreable hull (the disabled dropdown row), a short
 *  score series and three key moments. */
function sampleReport(): StaticReport {
  return {
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
        shipId: 1,
        name: "me",
        playerName: "me",
        teamId: 0,
        isRecorder: true,
        diedAt: null,
        coverage: {
          aliveFrom: 0,
          aliveTo: 600,
          samples: 40,
          gapSeconds: 19,
          completeness: 0.97,
          gapSegments: [[200, 219]],
        },
        whole: {
          wholeGame: 0.59,
          wholeFire: 0.83,
          wholeMove: 0.42,
          contribution: 59500,
          contributionShots: 11,
        },
        outcome: null,
      },
      {
        entityId: 9,
        shipId: 9,
        name: "foe",
        playerName: "foe",
        teamId: 1,
        isRecorder: false,
        diedAt: 300,
        coverage: {
          aliveFrom: 0,
          aliveTo: 300,
          samples: 0,
          gapSeconds: 300,
          completeness: 0,
          gapSegments: [[0, 300]],
        },
        whole: null,
        outcome: null,
      },
    ],
    timeline: [
      { t: 0, inst: 0.5, confidence: 0.5, fire: 0.4, fired: false, fireProb: 0.6, hpLost: null, move: 0.55 },
      { t: 100, inst: 0.08, confidence: 0.62, fire: null, fired: null, fireProb: null, hpLost: null, move: 0.2 },
      { t: 300, inst: 0.3, confidence: 0.7, fire: 0.7, fired: true, fireProb: 0.7, hpLost: 1200, move: 0.4 },
      { t: 600, inst: 0.2, confidence: 0.6, fire: 0.3, fired: false, fireProb: 0.7, hpLost: null, move: 0.25 },
    ],
    moments: [
      moment({ t: 100 }),
      moment({ t: 250, category: "forcedShot", fired: false }),
      moment({ t: 500, category: "strongWindow", hpLostWindow: null }),
    ],
  };
}

/** Mount the panel behind a host and hand back the exposed capture handle
 *  through the SAME component-ref plumbing StaticReportModal uses. */
function mountPanel(): {
  handle: () => { capturePng: () => Promise<Uint8Array> };
  wrapper: ReturnType<typeof mount>;
} {
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
          report: sampleReport(),
          onPick: () => {},
        });
    },
  });
  const wrapper = mount(Host);
  return {
    handle: () => {
      if (!handle) throw new Error("panel handle not mounted");
      return handle;
    },
    wrapper,
  };
}

describe("formatHp", () => {
  it("compacts damage values", () => {
    expect(formatHp(999)).toBe("999");
    expect(formatHp(84_200)).toBe("84.2k");
    expect(formatHp(1_310_000)).toBe("1.31M");
  });
});

describe("formatDuration", () => {
  it("renders M:SS, H:MM:SS past the hour, and a dash without data", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(1053)).toBe("17:33");
    expect(formatDuration(3661)).toBe("1:01:01");
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

describe("formatClock", () => {
  it("renders the mm:ss battle clock", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65)).toBe("01:05");
    expect(formatClock(1053)).toBe("17:33");
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
  it("renders the export column at 2x into the PNG bytes the clipboard takes", async () => {
    const node = document.createElement("div");
    // The long image must capture the FULL column, not the scroll viewport:
    // the height handed to the renderer is the node's scrollHeight.
    Object.defineProperty(node, "scrollHeight", { value: 4321 });
    const bytes = new Uint8Array([9, 8, 7]);
    vi.mocked(toBlob).mockReset();
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
    vi.mocked(toBlob).mockReset();
    vi.mocked(toBlob).mockResolvedValue(null);
    await expect(captureReportPng(document.createElement("div"))).rejects.toThrow(/no PNG/);
  });

  it("propagates a renderer failure so the copy toast can report it", async () => {
    vi.mocked(toBlob).mockReset();
    vi.mocked(toBlob).mockRejectedValue(new Error("svg render boom"));
    await expect(captureReportPng(document.createElement("div"))).rejects.toThrow(
      "svg render boom",
    );
  });
});

describe("StaticReportPanel wiring", () => {
  it("shows only the selected perspective and mounts the editor timeline", () => {
    const { handle, wrapper } = mountPanel();
    expect(handle).toBeTruthy();
    const trigger = wrapper.find(".srp-picker__trigger");
    expect(trigger.exists()).toBe(true);
    expect(trigger.text()).toContain("me");
    // The old roster grid + card wall are gone.
    expect(wrapper.find(".srp-picker__chip").exists()).toBe(false);
    expect(wrapper.find(".srp-moment").exists()).toBe(false);
    expect(wrapper.find(".srp-tl").exists()).toBe(true);
    expect(wrapper.findAll(".srp-tl__kf")).toHaveLength(3);
  });

  it("renders the host-resolved identity, provenance and shared footer", () => {
    const wrapper = mount(StaticReportPanel, {
      props: {
        report: sampleReport(),
        onPick: () => {},
        sheet: {
          identity: {
            name: "me",
            clanTag: "HOOD",
            dogTag: null,
            shipType: "Destroyer",
            shipName: "Shimakaze",
            tier: 10,
          },
          meta: {
            mapLang: "zh-CN",
            modeLabel: "Domination",
            modeColor: "#3f8cff",
            battleStart: "2026-11-06 12:34",
            replayHash:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
          roster: new Map([
            [
              1,
              {
                clanTag: "HOOD",
                dogTag: null,
                shipType: "Destroyer",
                shipName: "Shimakaze",
                tier: 10,
              },
            ],
          ]),
        },
      },
    });
    // Identity trigger: clan tag + ship line, emblem fallback (no dog tag).
    expect(wrapper.find(".srp-picker__clan").text()).toBe("[HOOD]");
    expect(wrapper.find(".srp-picker__ship").text()).toContain("X");
    expect(wrapper.find(".srp-picker__ship").text()).toContain("Shimakaze");
    expect(
      wrapper.find(".srp-picker__ship img").attributes("src"),
    ).toContain("icon_ally_destroyer");
    // No dog tag in the fixture: the team-tinted initial plate stands in for
    // the emblem (a bare PlayerBadge disc read as an unfinished download).
    expect(wrapper.find(".srp-picker__avatar-initial").text()).toBe("M");
    // Battle provenance: the header's own map chip, the mode tag, the start
    // time, the green at-end fate, and the replay fingerprint tail.
    expect(wrapper.find(".srp-head__meta .map-tag").exists()).toBe(true);
    expect(wrapper.find(".srp-head__mode").text()).toBe("Domination");
    expect(wrapper.text()).toContain("2026-11-06 12:34");
    expect(wrapper.text()).toContain("replay.report.survivedAtEnd");
    expect(wrapper.find(".srp-head__hash").text()).toBe("#abcdef");
    // The long image closes on the shared watermark with the AI extras.
    expect(wrapper.find(".shot-footer").exists()).toBe(true);
    expect(wrapper.find(".shot-footer__note").text()).toBe(
      "replay.report.aiNotice",
    );
    expect(wrapper.find(".shot-footer__meta").text()).toBe(
      "replay.report.aiVersion",
    );
  });

  it("maps coverage gaps over the player's observed interval", () => {
    const report = sampleReport();
    report.roster[0].coverage = {
      ...report.roster[0].coverage,
      aliveTo: 300,
      gapSegments: [[100, 120]],
    };
    const wrapper = mount(StaticReportPanel, {
      props: { report, onPick: () => {} },
    });
    const gap = wrapper.find(".srp-coverage-bar__gap");
    // 100..120 s inside a 0..300 s observed interval, not the 600 s battle.
    expect(gap.attributes("style")).toContain("left: 33.333333");
    expect(gap.attributes("style")).toContain("width: 6.666666");
  });

  it("captures through the panel's own export root", async () => {
    vi.mocked(toBlob).mockReset();
    const bytes = new Uint8Array([4, 5, 6]);
    vi.mocked(toBlob).mockResolvedValue(new Blob([bytes], { type: "image/png" }));
    const { handle } = mountPanel();
    await nextTick();
    await expect(handle().capturePng()).resolves.toEqual(bytes);
    const node = vi.mocked(toBlob).mock.calls[0][0] as HTMLElement;
    expect(node.classList.contains("static-report-panel__export-root")).toBe(true);
  });

  it("renders the static annotation band before the clone and drops it after", async () => {
    vi.mocked(toBlob).mockReset();
    const seen = { callouts: -1, hint: -1, height: 0, staticPlate: false };
    vi.mocked(toBlob).mockImplementation((async (node: HTMLElement) => {
      seen.callouts = node.querySelectorAll(".srp-tl__callout").length;
      seen.hint = node.querySelectorAll(".srp-tl__hint").length;
      seen.height = node.scrollHeight;
      // The cloned frame must carry the chrome-less identity, never the
      // dropdown button.
      seen.staticPlate = node
        .querySelector(".srp-picker__trigger")
        ?.classList.contains("srp-picker__trigger--static") ?? false;
      return new Blob([new Uint8Array([1])], { type: "image/png" });
    }) as never);
    const { handle, wrapper } = mountPanel();
    await nextTick();
    const root = wrapper.find(".static-report-panel__export-root").element as HTMLElement;
    Object.defineProperty(root, "scrollHeight", { value: 2400 });
    await handle().capturePng();
    // The annotation band existed when html-to-image took the clone...
    expect(seen.callouts).toBe(3);
    expect(seen.hint).toBe(0);
    expect(seen.height).toBe(2400);
    expect(seen.staticPlate).toBe(true);
    // ...and the interactive surface came back afterwards.
    expect(wrapper.findAll(".srp-tl__callout")).toHaveLength(0);
    expect(wrapper.find(".srp-tl__hint").exists()).toBe(true);
  });
});
