/**
 * Contract: the two water-table surfaces (Dashboard's ship table and the
 * Lookup ship list) center their trailing date capsule in its column and
 * vertically center every data cell.
 *
 * The "最后战斗" column used to right-anchor the HkDateTag capsule with the
 * numbers, so the pill's rounded edge sat on the number column's right rule
 * and its text read off the column (the owner's screenshot complaint). The
 * column now centers both the capsule and its header caption; a shared fixed
 * 80px track on the Lookup caption + rows is what lets the two flex rows
 * agree on one axis (their intrinsic widths differed: caption ≈42px, capsule
 * ≈71px). Numbers and their captions keep their right alignment — only the
 * date column changed horizontally. Vertically, the date cell pins
 * align-items: center and shares the row's 1.5 line box with the number
 * cells, so the pill box and the digit line boxes center on the row's
 * optical center instead of relying on the flex default.
 *
 * Scope: the component stylesheets only — the during-battle roster tables
 * (LiveView / post-battle) must NOT inherit this treatment; their files are
 * untouched (pinned by the name scan below covering only these two files).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Comments stripped: the prose here and in the SCSS deliberately NAME the
 *  library classes/states it explains, so both comment forms are removed
 *  before matching selectors. */
const strip = (rel: string) =>
  readFileSync(join(process.cwd(), "src", "views", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const dash = strip("DashboardView.scss");
const lookup = strip("LookupView.scss");

describe("Dashboard ship-table date-column alignment", () => {
  it("centers the date cell horizontally and vertically", () => {
    expect(dash).toMatch(
      /&__col-date\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1\.5;/s,
    );
    // The pre-fix right anchor must not come back inside the date cell.
    expect(dash).not.toMatch(/&__col-date\s*\{[^}]*justify-content:\s*flex-end;/s);
  });

  it("centers the head caption over the date column", () => {
    expect(dash).toMatch(/&:last-child\s*\{\s*text-align:\s*center;\s*\}/);
  });

  it("keeps the number cells and their captions right-aligned", () => {
    expect(dash).toMatch(/&__col-num\s*\{[^}]*text-align:\s*right;/s);
    // The generic head span rule still right-aligns, with the name exception
    // and the date exception as the only overrides.
    expect(dash).toMatch(/span\s*\{[^}]*text-align:\s*right;[^}]*&:first-child\s*\{\s*text-align:\s*left;/s);
  });
});

describe("Lookup ship-list date-column alignment", () => {
  it("puts the caption and the rows on one fixed 80px date track", () => {
    expect(lookup).toMatch(
      /\.lookup-view__head-date,\s*\.lookup-view__ship-date\s*\{[^}]*flex:\s*0 0 80px;[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s,
    );
    // No residual intrinsic/right-anchored track on either side of the pair.
    expect(lookup).not.toMatch(/\.lookup-view__(head|ship)-date\s*\{[^}]*text-align:\s*right;/s);
    expect(lookup).not.toMatch(/\.lookup-view__ship-date\s*\{[^}]*justify-content:\s*flex-end;/s);
  });

  it("keeps the number columns right-aligned", () => {
    for (const cls of ["battles", "wr", "dmg", "kd"]) {
      expect(lookup).toMatch(
        new RegExp("\\.lookup-view__ship-" + cls + "\\s*\\{[^}]*text-align:\\s*right;", "s"),
      );
    }
  });
});
