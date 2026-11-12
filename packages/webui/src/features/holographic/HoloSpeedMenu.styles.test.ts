/**
 * Playback-speed menu — the ONE-surface contract.
 *
 * 2026-11-12 user report (replay playback HUD): the speed menu rendered a
 * WHITE CARD INSIDE the popover's own card — a doubled frame with a ring of
 * popover padding around it. Cause: the host content div carried its own
 * background + border + border-radius + box-shadow INSIDE hikari's
 * HkPopover panel, which already paints exactly that chrome.
 *
 * The menu is now ONE hikari surface: HkPopover paints the card (glass,
 * border, radius, shadow, pop motion; the phone sheet on phones) and
 * HkMenuPanel + HkMenuActionItem supply the row grammar. These tests pin
 * the two things that keep it that way:
 *
 *  1. STRUCTURE (HoloSpeedMenu.test.tsx) — the rows ARE hikari's menu rows
 *     and the host adds no surface element of its own.
 *  2. STYLES (here) — the compiled HUD sheet restyles the PALETTE only. It
 *     must not re-add a frame/inset to the popover panel or to the rows:
 *     any border, background, radius, shadow or padding aimed at the popup
 *     content is the double frame coming back. The only descriptor the hook
 *     may touch besides the hud custom properties is hikari's own
 *     --hk-popover-bg token.
 */
// @vitest-environment node
import { resolve } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

/** Compiled HUD sheet, comments stripped: the prose above deliberately
 *  NAMES selectors and properties, so matching raw output would pass on
 *  comments alone. */
const css = compile(
  resolve("src/features/holographic/HolographicMap.scss"),
  { style: "expanded" },
)
  .css.replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Property names declared by every rule whose selector list contains
 *  `selector` (custom properties included, verbatim). */
function propertiesOf(selector: string): string[] {
  const props: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(";")) {
      const name = decl.split(":")[0]?.trim();
      if (name) props.push(name);
    }
  }
  return props;
}

/** Sass prints the attribute selector unquoted. */
const LIGHT_HOOK = ":root[data-mode=light] .holo-map__speed-pop";

describe("playback-speed menu palette hook", () => {
  it("exists on the popover panel for both themes", () => {
    expect(propertiesOf(".holo-map__speed-pop").length).toBeGreaterThan(0);
    expect(propertiesOf(LIGHT_HOOK).length).toBeGreaterThan(0);
  });

  it("hands the hud palette to hikari's popover background token", () => {
    const base = propertiesOf(".holo-map__speed-pop");
    // Palette ramp: the hud mixin's tokens ...
    expect(base.some((p) => p.startsWith("--holo-hud-"))).toBe(true);
    // ... handed to hikari's OWN popover background token, so the panel
    // keeps painting ONE surface (the token resolves against whichever
    // palette the theme block above last set).
    expect(base).toContain("--hk-popover-bg");
  });

  it("draws no frame or inset of its own", () => {
    // Palette tokens ride custom properties; the ONE geometry declaration
    // allowed is the panel's width floor. Anything else — border,
    // background, padding, radius, shadow, display… — is the host card
    // (the double panel) coming back.
    const GEOMETRY = new Set(["min-width"]);
    for (const selector of [".holo-map__speed-pop", LIGHT_HOOK]) {
      for (const prop of propertiesOf(selector)) {
        expect(prop.startsWith("--") || GEOMETRY.has(prop)).toBe(true);
      }
    }
  });

  it("leaves no host-drawn card or row chrome behind", () => {
    // The retired content card and its rows are gone from the sheet.
    for (const dead of [
      ".holo-map__speed-menu",
      ".holo-map__speed-opt",
      ".holo-map__speed-opt--on",
    ]) {
      expect(css).not.toContain(dead);
    }
  });
});
