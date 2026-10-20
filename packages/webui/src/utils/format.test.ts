/** Tests for the update banner's speed formatting: MB/s rounding plus the
 *  em-dash fallback shown before the mirror race produces a sample; and for
 *  formatLocalStamp: UTC backend stamps rendering as the local wall clock. */
import { describe, expect, it } from "vitest";

import { formatLocalStamp, formatSpeed } from "./format";

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

/** The machine-local `YYYY-MM-DD HH:MM` view of an instant, composed
 *  independently with the standard local getters — the expectation mirrors
 *  whatever timezone the test machine runs in. */
function localView(iso: string, dateOnly = false): string {
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return dateOnly ? day : `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

describe("formatLocalStamp", () => {
  it("renders a UTC stamp as the local wall clock, not the UTC digits", () => {
    const out = formatLocalStamp("2026-09-29T08:04:00Z");
    expect(out).toBe(localView("2026-09-29T08:04:00Z"));
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("honors explicit offsets — the instant, not the wall digits", () => {
    // 08:04+08:00 is 00:04Z: a raw string slice would echo 08:04 with the
    // "T" swapped in; the parsed view shifts it to the local clock.
    const out = formatLocalStamp("2026-09-29T08:04:00+08:00");
    expect(out).toBe(localView("2026-09-29T08:04:00+08:00"));
    expect(out).not.toContain("T");
  });

  it("parses chrono's to_rfc3339 output (offset with microseconds)", () => {
    expect(formatLocalStamp("2026-10-20T07:10:00.123456+00:00")).toBe(
      localView("2026-10-20T07:10:00.123456+00:00"),
    );
  });

  it("renders the date alone with dateOnly", () => {
    expect(formatLocalStamp("2026-09-29T08:04:00Z", true)).toBe(
      localView("2026-09-29T08:04:00Z", true),
    );
    expect(formatLocalStamp("2026-09-29T08:04:00Z", true)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps the legacy raw-slice rendering for unparseable input", () => {
    expect(formatLocalStamp("20260929_0804")).toBe("20260929_0804");
    expect(formatLocalStamp("2026-09-29T08:04 o'clock", true)).toBe("2026-09-29");
  });

  it("renders empty for empty input", () => {
    expect(formatLocalStamp("")).toBe("");
    expect(formatLocalStamp(null)).toBe("");
    expect(formatLocalStamp(undefined)).toBe("");
  });
});
