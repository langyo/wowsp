/** Tests for the live hover-card placement policy:
 *  - below the anchor strip when the card fits under it (unchanged delta);
 *  - flipped above with the card's REAL height, keeping a constant gap —
 *    the regression case: an estimated 420px height used to float sparse
 *    cards in thin air far above the anchor the user is pointing at;
 *  - viewport clamps for both axes, with a too-tall card pinned to the top
 *    edge (it scrolls internally under its max-height cap). */
import { describe, expect, it } from "vitest";

import { LIVE_CARD_EDGE_PX, placeLiveCard } from "./liveCardPlacement";

const anchor = { left: 200, top: 500, right: 560, bottom: 540 };

describe("placeLiveCard", () => {
  it("hangs below the strip when the card fits under it", () => {
    expect(placeLiveCard(anchor, 360, 300, 1920, 1080)).toEqual({
      left: 200,
      top: 548,
    });
  });

  it("stays below at exactly the edge-margin boundary", () => {
    // below (548) + height == viewport - edge: still fits below.
    expect(placeLiveCard(anchor, 360, 1080 - 8 - 548, 1920, 1080).top).toBe(548);
  });

  it("flips above with the real card height and keeps the 8px gap", () => {
    // A 260px card does not fit under a bottom-540 anchor in an 800px
    // viewport; the flip must measure 260px, landing the card's bottom edge
    // exactly GAP above the strip (the old estimate left it ~168px high).
    expect(placeLiveCard(anchor, 360, 260, 1920, 800)).toEqual({
      left: 200,
      top: 500 - 8 - 260,
    });
  });

  it("pins a card too tall for either side to the top edge", () => {
    expect(placeLiveCard(anchor, 360, 760, 1920, 800).top).toBe(LIVE_CARD_EDGE_PX);
  });

  it("clamps the left edge inside the viewport on both sides", () => {
    const nearRight = { left: 1700, top: 100, right: 1800, bottom: 140 };
    expect(placeLiveCard(nearRight, 360, 200, 1920, 1080).left).toBe(1920 - 360 - 8);
    const nearLeft = { left: 2, top: 100, right: 100, bottom: 140 };
    expect(placeLiveCard(nearLeft, 360, 200, 1920, 1080).left).toBe(LIVE_CARD_EDGE_PX);
  });
});
