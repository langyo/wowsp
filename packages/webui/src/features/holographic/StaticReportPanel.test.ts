/**
 * StaticReportPanel tests — the shared formatters, the DOM-node → PNG
 * capture contract the modal's copy action drives, and the panel wiring: the
 * head shows only the selected perspective behind the dropdown, the editor
 * timeline replaces the old card wall, and a copy renders its capture-mode
 * sheet in a hidden OFFSCREEN host — the visible window never enters capture
 * mode (the 2026-11-07 user request: no temporary page mutation for a
 * screenshot).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, watchEffect } from "vue";
import { toBlob } from "html-to-image";

import { initLocaleMessages, t as i18nT } from "@/i18n";
import type { StaticMoment, StaticReport } from "@/api";
import StaticReportPanel, { captureReportPng } from "./StaticReportPanel";
import type { ReportSheetView } from "./reportSheet";
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
    modelSources: {
      fire: "models/fire.onnx",
      moveModel: "models/move.onnx",
      torpedoModel: "models/torpedo.onnx",
    },
    entityId: 1,
    roster: [
      {
        entityId: 1,
        shipId: 1,
        shipClass: "Destroyer",
        fireApplicable: true,
        torpedoApplicable: true,
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
          // E26/P2 torpedo diagnostics: an independent dimension (numbers
          // -> the head's torpedo card; never part of wholeGame).
          torpedo: {
            agreement: 0.62,
            meanProb: 0.016,
            canLaunchWindows: 14,
            launches: 3,
          },
        },
        outcome: null,
      },
      {
        entityId: 9,
        shipId: 9,
        shipClass: null,
        fireApplicable: true,
        torpedoApplicable: true,
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

/** The host-resolved sheet (identity faces + battle provenance): the
 *  inert-telemetry / static identity assertions need the replay fingerprint
 *  tag to exist. */
function sampleSheet(): ReportSheetView {
  return {
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
  };
}

/** Mount the panel behind a host and hand back the exposed capture handle
 *  through the SAME component-ref plumbing StaticReportModal uses. */
function mountPanel(sheet: ReportSheetView | null = null): {
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
          sheet,
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

/** The offscreen capture host is Teleported to <body> (the VTU mount itself
 *  stays detached), so the captured sheet is found through the document —
 *  never through the mount wrapper. */
function captureHostNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    ".static-report-panel__capture-host",
  );
}

function captureExportRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    ".static-report-panel__capture-host .static-report-panel__export-root",
  );
}

/** Start a capture and wait for the offscreen sheet to mount. happy-dom has
 *  no layout engine, so the offscreen column's natural height is pinned on
 *  the mounted node before the renderer runs (a real browser reports it from
 *  layout). Returns while the capture is still in flight. */
async function startCapture(
  capturePng: () => Promise<Uint8Array>,
  scrollHeight = 2400,
): Promise<{ pending: Promise<Uint8Array>; offscreen: HTMLElement }> {
  const pending = capturePng();
  await nextTick();
  const offscreen = captureExportRoot();
  if (!offscreen) throw new Error("offscreen capture sheet did not mount");
  Object.defineProperty(offscreen, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  return { pending, offscreen };
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

  it("forwards a timeline keyframe click to the host seek", async () => {
    const onSeek = vi.fn();
    const wrapper = mount(StaticReportPanel, {
      props: { report: sampleReport(), onPick: () => {}, onSeek },
    });
    await wrapper.findAll(".srp-tl__kf")[1].trigger("click");
    // The panel is a pass-through: the modal/host owns the close + seek +
    // camera focus, but the chosen battle second must survive the hop.
    expect(onSeek).toHaveBeenCalledWith(250);
  });

  it("renders the host-resolved identity, provenance and shared footer", () => {
    const wrapper = mount(StaticReportPanel, {
      props: {
        report: sampleReport(),
        onPick: () => {},
        sheet: sampleSheet(),
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
    // Battle provenance: the header's own map chip, the mode tag, the green
    // at-end fate, and the telemetry TAGS (start / fingerprint / duration —
    // house HkCopyBadge pills, interactive only inside WoWSP).
    expect(wrapper.find(".srp-head__meta .map-tag").exists()).toBe(true);
    expect(wrapper.find(".srp-head__mode").text()).toBe("Domination");
    expect(wrapper.find(".srp-head__time").text()).toBe("2026-11-06 12:34");
    expect(wrapper.text()).toContain("replay.report.survivedAtEnd");
    const hashTag = wrapper.find(".srp-head__hash");
    expect(hashTag.text()).toBe("#abcdef");
    expect(hashTag.attributes("role")).toBe("button");
    expect(wrapper.find(".srp-head__duration").exists()).toBe(true);
    // The WATERMARK is a share artifact: the interactive window must not
    // grow a footer band (only the copied long image carries it).
    expect(wrapper.find(".shot-footer").exists()).toBe(false);
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

  it("captures the offscreen copy of the export column, never the live node", async () => {
    vi.mocked(toBlob).mockReset();
    const bytes = new Uint8Array([4, 5, 6]);
    vi.mocked(toBlob).mockResolvedValue(new Blob([bytes], { type: "image/png" }));
    const { handle, wrapper } = mountPanel();
    await nextTick();
    const liveRoot = wrapper.find(".static-report-panel__export-root")
      .element as HTMLElement;
    const { pending, offscreen } = await startCapture(
      () => handle().capturePng(),
      4321,
    );
    // The raw node handed to html-to-image is the OFFSCREEN column, mounted
    // under the hidden Teleport host — not the window's own export root.
    const host = captureHostNode();
    expect(host?.contains(offscreen)).toBe(true);
    expect(offscreen.closest(".static-report-panel--capture")).not.toBeNull();
    // The host is a REAL-LAYOUT fixed layer parked far off-viewport (no
    // display:none / visibility:hidden: html-to-image reads computed
    // styles), inert so a copy never adds a tab stop, and pinned to the
    // live column's width (happy-dom reports 0 → the 1128 fallback).
    expect(host?.style.position).toBe("fixed");
    expect(host?.style.left).toBe("-30000px");
    expect(host?.style.top).toBe("0px");
    expect(host?.style.pointerEvents).toBe("none");
    expect(host?.style.zIndex).toBe("-1");
    expect(host?.style.display).toBe("");
    expect(host?.style.visibility).toBe("");
    expect(host?.getAttribute("inert")).not.toBeNull();
    expect(host?.style.width).toBe("1128px");
    expect(offscreen.parentElement?.style.width).toBe("1128px");
    const captured = await pending;
    expect(captured).toEqual(bytes);
    const node = vi.mocked(toBlob).mock.calls[0][0] as HTMLElement;
    expect(node).toBe(offscreen);
    expect(node).not.toBe(liveRoot);
    // The offscreen height is the offscreen column's natural height (the
    // long image), and the host is gone once the bytes come back.
    expect(vi.mocked(toBlob).mock.calls[0][1]).toMatchObject({ height: 4321 });
    expect(captureHostNode()).toBeNull();
  });

  it("pins the score track's SVG paint inline on the offscreen copy, never the live one", async () => {
    vi.mocked(toBlob).mockReset();
    const bytes = new Uint8Array([8, 8, 8]);
    vi.mocked(toBlob).mockResolvedValue(new Blob([bytes], { type: "image/png" }));
    const { handle, wrapper } = mountPanel();
    await nextTick();
    const liveRoot = wrapper.find(".static-report-panel__export-root")
      .element as HTMLElement;
    // html-to-image deep-clones SVG subtrees and short-circuits its own style
    // walk there, and the cloned frame renders WITHOUT the app stylesheets:
    // the capture must hand it the score track's paint as INLINE styles.
    // Stub the computed style the way a real browser reports the track's
    // classes (fill: none + the blue move-model envelope).
    const svgPaint: Record<string, string> = {
      fill: "none",
      stroke: "rgb(87, 166, 255)",
      "stroke-width": "2px",
      "stroke-linecap": "round",
    };
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element: Element) =>
        element.namespaceURI === "http://www.w3.org/2000/svg"
          ? ({
              getPropertyValue: (name: string) => svgPaint[name] ?? "",
            } as unknown as CSSStyleDeclaration)
          : realGetComputedStyle(element),
      );
    try {
      const { pending, offscreen } = await startCapture(
        () => handle().capturePng(),
        2400,
      );
      await pending;
      // The walk read the SVG descendants' computed styles...
      expect(spy).toHaveBeenCalled();
      // ...and the OFFSCREEN copy (the node html-to-image clones) carries the
      // stubbed paint as inline declarations — what the deep clone keeps.
      const capturedPaths = offscreen.querySelectorAll(".srp-tl__score-line");
      expect(capturedPaths).toHaveLength(2);
      for (const path of capturedPaths) {
        const style = path.getAttribute("style") ?? "";
        expect(style).toContain("fill: none");
        expect(style).toContain("rgb(87, 166, 255)");
      }
      // Grid lines were the bug's other casualty: they lost their stroke and
      // vanished from the copied image.
      const gridLine = offscreen.querySelector(".srp-tl__score-grid");
      expect(gridLine?.getAttribute("style") ?? "").toContain(
        "rgb(87, 166, 255)",
      );
      // The LIVE window never got the pin: a copy leaves it untouched.
      const livePaths = liveRoot.querySelectorAll(".srp-tl__score-line");
      expect(livePaths).toHaveLength(2);
      for (const path of livePaths) {
        expect(path.getAttribute("style")).toBeNull();
      }
      expect(captureHostNode()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("renders the annotation band and share footer offscreen, never in the live window", async () => {
    vi.mocked(toBlob).mockReset();
    const seen = {
      callouts: -1,
      hint: -1,
      height: 0,
      staticPlate: false,
      captureClass: false,
      footer: false,
      aiNote: "",
      aiMeta: "",
      hashRole: "",
    };
    const live = {
      callouts: -1,
      captureClass: false,
      footer: false,
      hashRole: "",
      pickerDisabled: true,
    };
    let liveRoot: HTMLElement | null = null;
    vi.mocked(toBlob).mockImplementation((async (node: HTMLElement) => {
      seen.callouts = node.querySelectorAll(".srp-tl__callout").length;
      seen.hint = node.querySelectorAll(".srp-tl__hint").length;
      seen.height = node.scrollHeight;
      // The cloned frame must carry the chrome-less identity, never the
      // dropdown button.
      seen.staticPlate =
        node
          .querySelector(".srp-picker__trigger")
          ?.classList.contains("srp-picker__trigger--static") ?? false;
      // The capture palette is pinned on the offscreen wrapper.
      seen.captureClass =
        node
          .closest(".static-report-panel")
          ?.classList.contains("static-report-panel--capture") ?? false;
      // The telemetry tags are INERT in the share frame (a copied image is
      // not interactive): no button role on the fingerprint pill.
      seen.hashRole =
        node.querySelector(".srp-head__hash")?.getAttribute("role") ?? "";
      // The cloned share frame carries the watermark + AI extras...
      seen.footer = node.querySelector(".shot-footer") != null;
      seen.aiNote = node.querySelector(".shot-footer__note")?.textContent ?? "";
      seen.aiMeta = node.querySelector(".shot-footer__meta")?.textContent ?? "";
      // ...and at this SAME instant the LIVE window (what the user sees)
      // carries none of the capture-only chrome.
      live.callouts =
        liveRoot?.querySelectorAll(".srp-tl__callout").length ?? -1;
      live.captureClass =
        liveRoot?.closest(".static-report-panel--capture") != null;
      live.footer = liveRoot?.querySelector(".shot-footer") != null;
      live.hashRole =
        liveRoot?.querySelector(".srp-head__hash")?.getAttribute("role") ?? "";
      live.pickerDisabled =
        liveRoot
          ?.querySelector(".srp-picker__trigger")
          ?.hasAttribute("disabled") ?? true;
      return new Blob([new Uint8Array([1])], { type: "image/png" });
    }) as never);
    const { handle, wrapper } = mountPanel(sampleSheet());
    await nextTick();
    liveRoot = wrapper.find(".static-report-panel__export-root")
      .element as HTMLElement;
    const { pending, offscreen } = await startCapture(
      () => handle().capturePng(),
      2400,
    );
    await pending;
    // The annotation band existed when html-to-image took the clone...
    expect(seen.callouts).toBe(3);
    expect(seen.hint).toBe(0);
    expect(seen.height).toBe(2400);
    expect(seen.staticPlate).toBe(true);
    expect(seen.captureClass).toBe(true);
    expect(seen.hashRole).toBe("");
    // ...and so did the watermark + AI extras...
    expect(seen.footer).toBe(true);
    expect(seen.aiNote).toBe("replay.report.aiNotice");
    expect(seen.aiMeta).toBe("replay.report.aiVersion");
    // ...while the window showed NONE of it: no annotation band, no footer,
    // still-interactive telemetry tags and picker.
    expect(live.callouts).toBe(0);
    expect(live.captureClass).toBe(false);
    expect(live.footer).toBe(false);
    expect(live.hashRole).toBe("button");
    expect(live.pickerDisabled).toBe(false);
    // ...and the offscreen sheet is gone afterwards, the window untouched.
    expect(captureHostNode()).toBeNull();
    expect(offscreen.isConnected).toBe(false);
    expect(wrapper.findAll(".srp-tl__callout")).toHaveLength(0);
    expect(wrapper.find(".srp-tl__hint").exists()).toBe(true);
  });

  it("never puts the live window into capture mode", async () => {
    vi.mocked(toBlob).mockReset();
    vi.mocked(toBlob).mockResolvedValue(
      new Blob([new Uint8Array([7])], { type: "image/png" }),
    );
    const { handle, wrapper } = mountPanel(sampleSheet());
    await nextTick();
    const liveRoot = wrapper.find(".static-report-panel__export-root")
      .element as HTMLElement;
    /** The sheet's own DOM as the user sees it — a copy must leave it
     *  byte-identical (no class/attribute/text mutation, not even a
     *  transient frame). */
    const liveMarkup = liveRoot.outerHTML;
    /** The REAL live DOM assertions: no capture class, no annotation band,
     *  no watermark footer, interactive tags and picker. */
    const interactive = () => {
      expect(wrapper.find(".static-report-panel").classes()).not.toContain(
        "static-report-panel--capture",
      );
      expect(wrapper.findAll(".srp-tl__callout")).toHaveLength(0);
      expect(wrapper.find(".srp-tl__hint").exists()).toBe(true);
      expect(wrapper.find(".shot-footer").exists()).toBe(false);
      expect(wrapper.find(".srp-head__hash").attributes("role")).toBe("button");
      const trigger = wrapper.find(".srp-picker__trigger");
      expect(trigger.attributes("disabled")).toBeUndefined();
      expect(trigger.classes()).not.toContain("srp-picker__trigger--static");
    };

    // BEFORE: plain interactive window, no capture host lingering.
    interactive();
    expect(captureHostNode()).toBeNull();

    // DURING: capture mode lives ONLY in the offscreen copy.
    const { pending, offscreen } = await startCapture(
      () => handle().capturePng(),
      2400,
    );
    expect(offscreen.querySelectorAll(".srp-tl__callout")).toHaveLength(3);
    expect(offscreen.querySelector(".shot-footer")).not.toBeNull();
    expect(
      offscreen
        .querySelector(".srp-picker__trigger")
        ?.classList.contains("srp-picker__trigger--static"),
    ).toBe(true);
    expect(
      offscreen
        .querySelector(".srp-picker__trigger")
        ?.hasAttribute("disabled"),
    ).toBe(true);
    interactive();
    await pending;

    // AFTER: offscreen host removed; the window never entered capture mode
    // and its own DOM is bit-for-bit what it was before the copy started.
    expect(captureHostNode()).toBeNull();
    interactive();
    expect(liveRoot.outerHTML).toBe(liveMarkup);
  });

  it("tears the offscreen host down when the renderer fails", async () => {
    vi.mocked(toBlob).mockReset();
    vi.mocked(toBlob).mockRejectedValue(new Error("svg render boom"));
    const { handle, wrapper } = mountPanel();
    await nextTick();
    const pending = handle().capturePng();
    // Attach the rejection expectation FIRST: the render runs on the frame
    // timers below, so the failure must never surface as an unhandled one.
    const settled = expect(pending).rejects.toThrow("svg render boom");
    await nextTick();
    const offscreen = captureExportRoot();
    expect(offscreen).not.toBeNull();
    Object.defineProperty(offscreen!, "scrollHeight", {
      value: 2400,
      configurable: true,
    });
    await settled;
    // Failure path still unmounts the hidden host (the copy toast owns the
    // user-facing error) and leaves the window untouched.
    expect(captureHostNode()).toBeNull();
    expect(wrapper.findAll(".srp-tl__callout")).toHaveLength(0);
    expect(wrapper.find(".srp-tl__hint").exists()).toBe(true);
  });
});

describe("StaticReportPanel fire applicability", () => {
  /** The recorder re-attributed to a class the fire model does not cover:
   *  the Rust side nulls the fire component and the contribution, and the
   *  head must say so instead of rendering a meaningless face. */
  function uncoveredReport(): StaticReport {
    const report = sampleReport();
    report.roster[0] = {
      ...report.roster[0],
      shipClass: "AirCarrier",
      fireApplicable: false,
      // A carrier has no torpedo model either — the independent card shows
      // its own N/A without disturbing the fire face.
      torpedoApplicable: false,
      whole: {
        wholeGame: 0.42,
        wholeFire: null,
        wholeMove: 0.42,
        contribution: null,
        contributionShots: null,
        torpedo: null,
      },
    };
    return report;
  }

  it("degrades the head for an uncovered class", () => {
    const wrapper = mount(StaticReportPanel, {
      props: { report: uncoveredReport(), onPick: () => {} },
    });
    const scores = wrapper.findAll(".srp-head__score");
    expect(scores).toHaveLength(3);
    // Contribution: "not applicable", never a dash and never a per-window
    // mean on a null contribution.
    expect(scores[0].text()).toContain("replay.report.notApplicable");
    expect(scores[0].text()).not.toContain("replay.report.perShot");
    // Whole-game: movement-only sub-line, the fire face never renders.
    expect(scores[1].text()).toContain("replay.report.moveOnly");
    expect(scores[1].text()).not.toContain("replay.report.fireMove");
    // The one-line explanation rides the head's coverage column.
    expect(wrapper.find(".srp-head__class-note").text()).toBe(
      "replay.report.classNotCovered",
    );
  });

  it("keeps the fire face for a covered class", () => {
    const wrapper = mount(StaticReportPanel, {
      props: { report: sampleReport(), onPick: () => {} },
    });
    expect(wrapper.find(".srp-head__class-note").exists()).toBe(false);
    const scores = wrapper.findAll(".srp-head__score");
    // Contribution 59500 -> 59.5k with its per-window mean; fire/move face.
    expect(scores[0].text()).toContain("59.5k");
    expect(scores[0].text()).toContain("replay.report.perShot");
    expect(scores[1].text()).toContain("replay.report.fireMove");
    expect(scores[1].text()).not.toContain("replay.report.moveOnly");
  });
});

describe("StaticReportPanel torpedo diagnostics", () => {
  // The card interpolates four numbers; load the real message table so the
  // assertions compare the same localized strings the card renders (the rest
  // of the suite runs on the raw key echo).
  beforeAll(async () => {
    await initLocaleMessages();
  });

  /** The head's E26/P2 torpedo card — an independent dimension. */
  const torpedoCard = (wrapper: ReturnType<typeof mount>) =>
    wrapper.find(".srp-head__score--torpedo");

  it("renders the four diagnostic numbers when the model scores the ship", () => {
    const wrapper = mount(StaticReportPanel, {
      props: { report: sampleReport(), onPick: () => {} },
    });
    const card = torpedoCard(wrapper);
    expect(card.exists()).toBe(true);
    // Agreement headline (0.62 -> 62%) and the full detail line: mean
    // probability (one decimal — the ~1.6% base rate must not round into a
    // false "2%"), can-launch volume and actual launches.
    expect(card.find("b").text()).toBe("62%");
    expect(card.text()).toContain(
      i18nT("replay.report.torpedoDetail", {
        a: "62",
        p: "1.6",
        n: 14,
        l: 3,
      }),
    );
    expect(card.text()).not.toContain(i18nT("replay.report.torpedoNotCovered"));
    // The independent block never leaks into the whole-game face.
    const scores = wrapper.findAll(".srp-head__score");
    expect(scores[1].text()).toContain("59%");
    expect(scores[1].text()).toContain(
      i18nT("replay.report.fireMove", { f: "83", m: "42" }),
    );
  });

  it("renders N/A when the torpedo model is not installed", () => {
    const report = sampleReport();
    report.modelSources = { ...report.modelSources, torpedoModel: null };
    report.roster[0] = {
      ...report.roster[0],
      whole: { ...report.roster[0].whole!, torpedo: null },
    };
    const wrapper = mount(StaticReportPanel, {
      props: { report, onPick: () => {} },
    });
    const card = torpedoCard(wrapper);
    expect(card.find(".srp-head__score-na").text()).toBe(
      i18nT("replay.report.torpedoNotCovered"),
    );
    // Never a 0 score and never a percentage face.
    expect(card.text()).not.toMatch(/\d+%/);
  });

  it("renders N/A for a hull the torpedo model does not cover", () => {
    const report = sampleReport();
    report.roster[0] = {
      ...report.roster[0],
      torpedoApplicable: false,
      whole: { ...report.roster[0].whole!, torpedo: null },
    };
    const wrapper = mount(StaticReportPanel, {
      props: { report, onPick: () => {} },
    });
    const card = torpedoCard(wrapper);
    expect(card.find(".srp-head__score-na").text()).toBe(
      i18nT("replay.report.torpedoNotCovered"),
    );
    expect(card.text()).not.toMatch(/\d+%/);
  });
});
