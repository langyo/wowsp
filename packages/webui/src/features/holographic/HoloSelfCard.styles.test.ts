/**
 * Contract: the holo ship plaque's HP readout slot is a FIXED-size box.
 *
 * The plaque sits in a content-sized flex row (the app's bottom-left
 * shipcard row beside the self-stats strip), so the head's widest line
 * sets the plaque width — and the whole row's width with it. The HP
 * numbers shrink digit-for-digit as the hull takes damage and a sunk ship
 * swaps them for a short localized label: without a reserved slot the
 * bottom-left card visibly shrinks at the exact moment the ship sinks
 * (user report: the plaque collapsed from "12,400 / 12,400" to "—").
 *
 * 17ch covers the widest possible readout ("999,999 / 999,999"); every
 * locale's sunk label is far narrower and right-aligns into the same box.
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
