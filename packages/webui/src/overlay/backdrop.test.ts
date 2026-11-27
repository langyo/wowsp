/**
 * The Tab overlay's plate-opacity dial: the pure percent → CSS clamp, the
 * <html> apply, and the stylesheet contract that keeps the dial wired to
 * BOTH glass plates with the shipped default as the inline fallback.
 *
 * overlay.scss is read as TEXT (not compiled): renderSample.test.ts inlines
 * the same file into a JS-less page, so the fallback inside each plate rule
 * is the only thing keeping that sample at the shipped default (80%).
 * Deleting a plate's fallback must fail here, in the spirit of
 * theme/surfaces.styles.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BACKDROP_OPACITY_PCT,
  OVERLAY_BACKDROP_CSS_VAR,
  applyOverlayBackdropPercent,
  overlayBackdropCss,
} from "./backdrop";

afterEach(() => {
  document.documentElement.style.removeProperty(OVERLAY_BACKDROP_CSS_VAR);
});

describe("overlayBackdropCss", () => {
  it("clamps into the dial's band and spells a percentage", () => {
    // Both band edges are real values — 100 is FULLY opaque, not a
    // fraction of some shipped alpha. 62 stays a legal in-band value (the
    // original chip glass); it just is not the default anymore.
    expect(overlayBackdropCss(50)).toBe("50%");
    expect(overlayBackdropCss(62)).toBe("62%");
    expect(overlayBackdropCss(100)).toBe("100%");
    // Out-of-band values keep the nearest intent instead of resetting.
    expect(overlayBackdropCss(49)).toBe("50%");
    expect(overlayBackdropCss(101)).toBe("100%");
  });

  it("answers the default for junk input", () => {
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(overlayBackdropCss(junk)).toBe("80%");
    }
  });
});

describe("applyOverlayBackdropPercent", () => {
  const applied = (): string =>
    document.documentElement.style.getPropertyValue(OVERLAY_BACKDROP_CSS_VAR);

  it("writes the dial as an inline custom property on <html>", () => {
    applyOverlayBackdropPercent(87);
    expect(applied()).toBe("87%");
    // A second apply replaces it in place — the live broadcast path.
    applyOverlayBackdropPercent(100);
    expect(applied()).toBe("100%");
  });

  it("writes the default instead of an invalid declaration", () => {
    applyOverlayBackdropPercent(Number.NaN);
    expect(applied()).toBe("80%");
  });
});

describe("overlay.scss plate wiring", () => {
  // Comments name the dial on purpose — only real declarations may answer
  // the contract.
  const css = readFileSync(
    join(process.cwd(), "src", "overlay", "overlay.scss"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** The BASE rule body (".selector {") — a compound/state selector must not
   *  stand in for the plate's own fill. */
  function baseRuleBody(selector: string): string | null {
    const escaped = selector.replace(/\./g, "\\.");
    const match = css.match(new RegExp("(?:^|\\n)" + escaped + "\\s*\\{([^}]*)\\}"));
    return match?.[1] ?? null;
  }

  it("drives BOTH glass plates through the dial with the shipped default inline", () => {
    const fill =
      "background: rgb(10 14 20 / var(" +
      OVERLAY_BACKDROP_CSS_VAR +
      ", " +
      DEFAULT_BACKDROP_OPACITY_PCT +
      "%));";
    for (const selector of [".overlay-chip", ".overlay-status"]) {
      const body = baseRuleBody(selector);
      expect(body, selector + " base rule").not.toBeNull();
      expect(body).toContain(fill);
    }
  });

  it("pins the public names the stylesheet contract depends on", () => {
    expect(OVERLAY_BACKDROP_CSS_VAR).toBe("--overlay-backdrop-opacity");
    expect(DEFAULT_BACKDROP_OPACITY_PCT).toBe(80);
  });
});
