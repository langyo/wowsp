/** canonicalNation: offline-DB spellings fold onto the app's canonical
 *  codes, events and unknown codes carry no nation (callers bucket those
 *  as "other"), and the 13 canonical codes pass through —
 *  case-insensitively, since encyclopedia codes arrive PascalCase. */
import { describe, expect, it } from "vitest";

import { canonicalNation } from "./nationFlags";

const CANONICAL = [
  "japan",
  "usa",
  "ussr",
  "germany",
  "uk",
  "france",
  "pan_asia",
  "italy",
  "netherlands",
  "commonwealth",
  "pan_america",
  "spain",
  "europe",
];

describe("canonicalNation", () => {
  it("passes the 13 canonical codes through verbatim", () => {
    for (const code of CANONICAL) {
      expect(canonicalNation(code)).toBe(code);
    }
  });

  it("renames the offline-DB spellings", () => {
    expect(canonicalNation("united_kingdom")).toBe("uk");
    expect(canonicalNation("russia")).toBe("ussr");
  });

  it("maps events to the empty code (the caller's 'other' bucket)", () => {
    expect(canonicalNation("events")).toBe("");
  });

  it("maps unknown codes to the empty code", () => {
    expect(canonicalNation("")).toBe("");
    expect(canonicalNation("atlantis")).toBe("");
  });

  it("folds PascalCase encyclopedia codes (case-insensitive)", () => {
    expect(canonicalNation("United_Kingdom")).toBe("uk");
    expect(canonicalNation("Russia")).toBe("ussr");
    expect(canonicalNation("Japan")).toBe("japan");
    expect(canonicalNation("Pan_America")).toBe("pan_america");
  });
});
