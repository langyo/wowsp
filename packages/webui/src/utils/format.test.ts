/** Tests for the update banner's speed formatting: MB/s rounding plus the
 *  em-dash fallback shown before the mirror race produces a sample. */
import { describe, expect, it } from "vitest";

import { formatSpeed } from "./format";

describe("formatSpeed", () => {
  it("renders one-decimal MB/s", () => {
    expect(formatSpeed(1_048_576)).toBe("1.0 MB/s");
    expect(formatSpeed(1.5 * 1_048_576)).toBe("1.5 MB/s");
    expect(formatSpeed(524_288)).toBe("0.5 MB/s");
    expect(formatSpeed(12.34 * 1_048_576)).toBe("12.3 MB/s");
  });

  it("falls back to an em-dash without a usable sample", () => {
    expect(formatSpeed(undefined)).toBe("—");
    expect(formatSpeed(null)).toBe("—");
    expect(formatSpeed(0)).toBe("—");
    expect(formatSpeed(-3)).toBe("—");
    expect(formatSpeed(Number.NaN)).toBe("—");
  });
});
