/** The mounted contract of the hikari-hosted PR trend chart: the tier
 *  guides (names/colors/hints), the per-dot inks and hints, the axis and
 *  x-tick text, and the stepped-domain/clipping rules that fall out of
 *  hikari's trendGeometry. The pure geometry itself is pinned upstream
 *  (hikari trendGeometry.test.ts); here we pin what THIS component feeds
 *  it and what a consumer reading the DOM sees. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import { statsPrefsState } from "@/stores/statsPrefs";
import { prTier } from "@/utils/winrate";
import PrTrendChart from "./PrTrendChart";
import type { PrTrendPoint } from "./prTrend";

enableAutoUnmount(afterEach);

const DAY = 86_400;

function pt(tSec: number, pr: number): PrTrendPoint {
  return { t: tSec, pr, battles: 3, winrate: 50 };
}

/** Deterministic stand-ins for the section's locale-owned formatters
 *  (the real ones format through toLocaleDateString). */
const fmtTick = (t: number) => `d${t}`;
const hintOf = (p: PrTrendPoint) => `hint ${p.pr}`;

describe("PrTrendChart (hikari HkTrendChart host)", () => {
  beforeEach(() => {
    // Standard English band wording regardless of the message tables —
    // the localized path would need the i18n tree this file never loads.
    statsPrefsState.value.localizedTiers = false;
  });
  afterEach(() => {
    statsPrefsState.value.localizedTiers = true; // the shipped default
  });

  it("draws the in-domain tier guides with names, inks, dash rhythm and hints", () => {
    // pr 1000→1500 over two days: the stepped domain lands on [0, 1500],
    // so the 750 and 1350 guides show and 1750+ clips.
    const wrapper = mount(PrTrendChart, {
      props: { points: [pt(0, 1000), pt(2 * DAY, 1500)], fmtTick, hintOf },
    });
    const svg = wrapper.find("svg.hk-trend-chart__svg");
    expect(svg.exists()).toBe(true);
    // The retired frame: 640×220, uniform scaling (the old xMidYMid meet).
    expect(svg.attributes("viewBox")).toBe("0 0 640 220");
    expect(svg.attributes("preserveAspectRatio")).toBe("xMidYMid meet");

    const guides = wrapper.findAll("line.hk-trend-chart__guide");
    expect(guides).toHaveLength(2);
    expect(guides.map((g) => g.attributes("stroke"))).toEqual([
      prTier(750).color, // tierBelowAvg — the band STARTING at 750
      prTier(1350).color, // tierAvg
    ]);
    // The threshold value rides data-hint like the old gutter carried it.
    expect(guides.map((g) => g.attributes("data-hint"))).toEqual(["750", "1350"]);
    // The old .pr-trend__guide dash rhythm (3 4), not hikari's alarm "6 4".
    expect(guides.map((g) => g.attributes("stroke-dasharray"))).toEqual(["3 4", "3 4"]);

    // Each guide is NAMED by the tier that starts there, in that ink.
    const labels = wrapper.findAll("text.hk-trend-chart__guide-label");
    expect(labels.map((l) => l.text())).toEqual(["Below Average", "Average"]);
    expect(labels.map((l) => l.attributes("fill"))).toEqual([
      prTier(750).color,
      prTier(1350).color,
    ]);
  });

  it("inks every vertex dot with its prTier color and carries its hint", () => {
    const wrapper = mount(PrTrendChart, {
      props: { points: [pt(0, 1000), pt(DAY, 1500)], fmtTick, hintOf },
    });
    const dots = wrapper.findAll("circle.hk-trend-chart__dot");
    expect(dots).toHaveLength(2);
    expect(dots.map((d) => d.attributes("fill"))).toEqual([
      prTier(1000).color, // tierAvg
      prTier(1500).color, // tierGood
    ]);
    expect(dots.map((d) => d.attributes("data-hint"))).toEqual(["hint 1000", "hint 1500"]);
    expect(dots.map((d) => d.attributes("r"))).toEqual(["3.5", "3.5"]);
  });

  it("renders the y-axis numbers with the tier-clearance drop and the caller's x ticks", () => {
    const wrapper = mount(PrTrendChart, {
      props: { points: [pt(0, 1000), pt(2 * DAY, 1500)], fmtTick, hintOf },
    });
    // Domain [0, 1500]: floor "0" always renders; the mid number (750)
    // sits exactly on the 750 guide's line and gives way to the tier
    // name (the 9px clearance); the ceiling "1500" clears the guides.
    const yTicks = wrapper.findAll("text.hk-trend-chart__y-tick");
    expect(yTicks.map((t) => t.text())).toEqual(["0", "1500"]);
    // Two samples → two ticks spanning the series, formatted through the
    // caller's unix-SECOND fmtTick.
    const xTicks = wrapper.findAll("text.hk-trend-chart__x-tick");
    expect(xTicks.map((t) => t.text())).toEqual(["d0", `d${2 * DAY}`]);
  });

  it("centers a lone point with a padded window and a single tick", () => {
    const wrapper = mount(PrTrendChart, {
      props: { points: [pt(1000, 1200)], fmtTick, hintOf },
    });
    const dots = wrapper.findAll("circle.hk-trend-chart__dot");
    expect(dots).toHaveLength(1);
    // A day of padding on both sides parks the vertex at the plot's
    // center (plotLeft 50 + plotW 570/2) — the old layout's centering.
    expect(dots[0]!.attributes("cx")).toBe("335");
    const xTicks = wrapper.findAll("text.hk-trend-chart__x-tick");
    expect(xTicks).toHaveLength(1);
    expect(xTicks[0]!.text()).toBe("d1000");
  });

  it("degrades to an empty axis frame for an empty series", () => {
    // The section keeps the chart frame standing when a filter matches
    // nothing; the empty pen must render axes without dots or ticks.
    const wrapper = mount(PrTrendChart, { props: { points: [], fmtTick, hintOf } });
    expect(wrapper.find("svg.hk-trend-chart__svg").exists()).toBe(true);
    expect(wrapper.findAll("circle.hk-trend-chart__dot")).toHaveLength(0);
    expect(wrapper.findAll("text.hk-trend-chart__x-tick")).toHaveLength(0);
    expect(wrapper.findAll("line.hk-trend-chart__guide")).toHaveLength(0);
    // The stepped domain still numbers the empty frame.
    expect(wrapper.findAll("text.hk-trend-chart__y-tick").map((t) => t.text())).toEqual([
      "0",
      "125",
      "250",
    ]);
  });

  it("mounts on hikari's contents host keeping the pr-trend hook class", () => {
    const wrapper = mount(PrTrendChart, {
      props: { points: [pt(0, 1000), pt(DAY, 1100)], fmtTick, hintOf },
    });
    const root = wrapper.find("div.hk-trend-chart");
    expect(root.exists()).toBe(true);
    expect(root.classes()).toContain("pr-trend");
    expect(root.attributes("style")).toContain("height: 220px");
    // The pen line draws with hikari's theme-token ink.
    expect(wrapper.find("polyline.hk-trend-chart__line").exists()).toBe(true);
  });
});
