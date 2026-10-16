/**
 * Placement math for the LiveShipMeta hover combat card (the flyout
 * teleported to <body> as a fixed-position box). Extracted pure so the flip
 * policy is unit-testable:
 *
 * - the card hugs the anchor strip's left edge, clamped inside the viewport;
 * - it prefers hanging BELOW the strip (bottom + gap);
 * - when the real rendered height would overflow the bottom, it flips ABOVE
 *   the strip (top - gap - height) — computed from the card's MEASURED
 *   height, never an estimate: the card is content-driven (a capped
 *   max-height spec table), and an estimate floats sparse cards in thin air
 *   far above the anchor;
 * - a card too tall for either side clamps to the top edge and scrolls
 *   internally (the max-height caps the box).
 */

/** Card body width (set as fixed inline style); the height is content-driven. */
export const LIVE_CARD_WIDTH_PX = 360;
/** Gap kept between the card and the anchor strip. */
export const LIVE_CARD_GAP_PX = 8;
/** Viewport clamp margin, same contract as the global tooltip popup. */
export const LIVE_CARD_EDGE_PX = 8;

/** The DOMRect members the placement reads (kept structural so tests stay
 *  DOM-free). */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LiveCardPlacement {
  left: number;
  top: number;
}

export function placeLiveCard(
  anchor: AnchorRect,
  cardWidth: number,
  cardHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): LiveCardPlacement {
  const left = Math.max(
    LIVE_CARD_EDGE_PX,
    Math.min(anchor.left, viewportWidth - cardWidth - LIVE_CARD_EDGE_PX),
  );
  const below = anchor.bottom + LIVE_CARD_GAP_PX;
  const top =
    below + cardHeight <= viewportHeight - LIVE_CARD_EDGE_PX
      ? below
      : Math.max(LIVE_CARD_EDGE_PX, anchor.top - LIVE_CARD_GAP_PX - cardHeight);
  return { left, top };
}
