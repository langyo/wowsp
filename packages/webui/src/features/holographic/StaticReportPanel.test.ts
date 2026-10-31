/**
 * StaticReportPanel helper tests — the pure formatters the long image
 * shares with the live panel.
 */
import { describe, expect, it } from "vitest";
import { coverageClass, formatHp, sectorLabel } from "./StaticReportPanel";

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
