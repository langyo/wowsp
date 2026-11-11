/**
 * Contract: the holo ship plaque's HP readout slot is a FIXED-size box.
 *
 * The plaque sits in the app's bottom-left shipcard row (beside the
 * self-stats strip, in a row whose width is locked to the player-HUD
 * block). The HP numbers shrink digit-for-digit as the hull takes damage
 * and a sunk ship swaps them for a short localized label: without a
 * reserved slot the bottom-left card visibly shrinks at the exact moment
 * the ship sinks (user report: the plaque collapsed from "12,400 /
 * 12,400" to "—").
 *
 * 17ch covers the widest possible readout ("999,999 / 999,999"); every
 * locale's sunk label is far narrower and right-aligns into the same box.
 *
 * The plaque itself is pinned to a FIXED 16rem width (no min/max span):
 * a content-sized plaque made the bottom-left footprint drift with every
 * replay's ship names — one replay's plaque sat visibly wider than
 * another's. Fixed width + ellipsizing name + the reserved readout slot
 * keep the row geometry constant.
 *
 * Source assertions on the shared @wowsp/holo stylesheet — same
 * conventions as the other *.styles.test.ts contracts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** HoloShipCard.scss with comments stripped (the prose deliberately names
 *  the selectors it pins). */
const scss = readFileSync(
  join(process.cwd(), "..", "holo", "src", "HoloShipCard.scss"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("HoloShipCard fixed readout slot", () => {
  it("reserves a constant inline size for the HP/sunk readout", () => {
    expect(scss).toMatch(
      /&__text\s*\{[^}]*min-inline-size:\s*17ch;[^}]*text-align:\s*end;/s,
    );
  });

  it("keeps the readout on one line (no wrap-driven width drift)", () => {
    expect(scss).toMatch(/&__text\s*\{[^}]*white-space:\s*nowrap;/s);
  });
});

describe("HoloShipCard fixed plaque width", () => {
  it("pins the plaque to a fixed 16rem width", () => {
    expect(scss).toMatch(/\.holo-ship-card\s*\{[^}]*width:\s*16rem;/s);
  });

  it("keeps no content-sized min/max width on the plaque", () => {
    expect(scss).not.toContain("min-width: 12rem");
    expect(scss).not.toContain("max-width: 20rem");
  });
});

describe("HoloShipCard hull silhouette keeps its native 1:1 aspect", () => {
  // 2026-11-11 user report: the hull art was being stretched/squashed
  // ("the hull must stay 1:1, no stretching"). Both branches used a fixed
  // 40px-tall board: on the 16rem plaque's ≈235px inner width that is a
  // 5.9:1 box, i.e. ~2.26x the bitmap's 404:155 ratio (and ~2.1x the
  // vector viewBox's 100:36 ratio) — the ship read visibly elongated.
  // The board must therefore derive its height from its width through the
  // art's OWN ratio; a fixed pixel height is the defect.

  it("sizes the bitmap board to the pack's 404:155 ratio", () => {
    // Every ship silhouette bitmap in the model pack is 404x155 (verified
    // across all 1,308 files), so the CSS box can carry that ratio and the
    // 100%x100% alpha mask becomes a UNIFORM scale.
    expect(scss).toMatch(
      /&__hull-png\s*\{[^}]*aspect-ratio:\s*404 \/ 155;[^}]*height:\s*auto;/s,
    );
  });

  it("sizes the vector fallback svg to its 100:36 viewBox ratio", () => {
    expect(scss).toMatch(
      /&__hull\s*\{[^}]*aspect-ratio:\s*100 \/ 36;[^}]*height:\s*auto;/s,
    );
  });

  it("keeps the mask fit uniform (box ratio == bitmap ratio)", () => {
    expect(scss).toMatch(/&__sil\s*\{[^}]*mask-size:\s*100% 100%;/s);
  });

  it("has no fixed pixel hull height left", () => {
    expect(scss).not.toMatch(/height:\s*40px/);
    expect(scss).not.toContain("min-height: calc(40px");
  });
});
