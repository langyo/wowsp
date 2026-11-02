/**
 * Contract: both donut families render their hikari HkDonutChart ring as a
 * FIXED 150px square and keep the two host layouts the migration lost.
 *
 * ef06819b moved both families onto hikari's HkDonutChart but the host SCSS
 * still styled the retired hand-rolled markup: the ring svg carries only a
 * viewBox and hikari sizes nothing, so it collapsed to 0×0 and every donut
 * disappeared. The host sheets now own the ring box explicitly (CSS beats
 * both hikari's intrinsic default and the width/height attributes a later
 * hikari sizing fix may add):
 *   - PlaytimeView: title over a centered 150px ring, legend BELOW it as a
 *     wrapping centered group (four blocks share one row);
 *   - ShipDistCharts: ring beside a shrinking legend, vertically centered,
 *     ring allowed down to a 96px floor on a narrow pie column.
 * The retired selectors (.playtime-pie__*, .ship-dist-charts__pie/legend/
 * slice) are dead markup — the tests pin them OUT so a future edit cannot
 * resurrect a second styling path for markup that no longer exists.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const strip = (rel: string[]) =>
  readFileSync(join(process.cwd(), "src", ...rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const playtime = strip(["views", "PlaytimeView.scss"]);
const stats = strip(["components", "stats", "ShipDistCharts.scss"]);

describe("Playtime breakdown donut host styles", () => {
  it("sizes the hikari ring svg to a fixed 150px square", () => {
    expect(playtime).toMatch(
      /\.playtime-breakdown-pie\s*\{[\s\S]*?\n  \.hk-donut__ring\s*\{[^}]*display:\s*block;[^}]*width:\s*150px;[^}]*height:\s*150px;/s,
    );
  });

  it("stacks the ring above a centered, wrapping legend", () => {
    expect(playtime).toMatch(
      /\.playtime-breakdown-pie\s*\{[\s\S]*?\n  \.hk-donut\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*center;/s,
    );
    expect(playtime).toMatch(
      /\.playtime-breakdown-pie\s*\{[\s\S]*?\n  \.hk-donut__legend\s*\{[^}]*justify-content:\s*(safe )?center;[^}]*flex-wrap:\s*wrap;/s,
    );
  });

  it("keeps the pre-migration hover-only percent legend grammar", () => {
    // hikari paints an inline percent segment; the pre-migration legend
    // contract keeps percents in the row hint and the 6px dot, which is
    // what lets the fixed 150px ring survive the narrow blocks.
    expect(playtime).toMatch(
      /\n  \.hk-donut__legend-pct\s*\{\s*display:\s*none;\s*\}/,
    );
    expect(playtime).toMatch(
      /\n  \.hk-donut__legend-dot\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;/s,
    );
  });

  it("keeps the retired hand-rolled pie selectors out", () => {
    expect(playtime).not.toMatch(/\.playtime-pie(?!-breakdown)/);
  });
});

describe("ShipDistCharts donut host styles", () => {
  it("sizes the ring through the wrapper it sits in", () => {
    expect(stats).toMatch(
      /\.ship-dist-charts__pie-body\s+\.hk-donut__ring-wrap\s*\{[^}]*flex:\s*0 1 auto;[^}]*width:\s*150px;[^}]*min-width:\s*96px;/s,
    );
    expect(stats).toMatch(
      /\.ship-dist-charts__pie-body\s+\.hk-donut__ring\s*\{[^}]*width:\s*100%;[^}]*aspect-ratio:\s*1;/s,
    );
  });

  it("keeps ring and legend side by side, vertically centered", () => {
    // hikari's root is a wrapping row; the host pins it to one line so the
    // ring shrinks instead of the legend dropping below (pre-migration
    // grammar). The body's align-items centers the whole pair.
    expect(stats).toMatch(
      /\.ship-dist-charts__pie-body\s+\.hk-donut\s*\{[^}]*flex-wrap:\s*nowrap;/s,
    );
    expect(stats).toMatch(
      /\.ship-dist-charts__pie-body\s*\{[^}]*align-items:\s*center;/s,
    );
  });

  it("keeps the pre-migration hover-only percent legend grammar", () => {
    expect(stats).toMatch(
      /\.ship-dist-charts__pie-body \.hk-donut__legend-pct\s*\{\s*display:\s*none;\s*\}/,
    );
    expect(stats).toMatch(
      /\.ship-dist-charts__pie-body \.hk-donut__legend-dot\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;/s,
    );
  });

  it("keeps the retired ship-dist donut selectors out", () => {
    expect(stats).not.toMatch(/\.ship-dist-charts__pie(?![-_\w])/);
    expect(stats).not.toMatch(/\.ship-dist-charts__(legend|slice)/);
  });
});
