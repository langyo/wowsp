/** Keep the Tab overlay's stat chips inside the overlay window.
 *
 *  Chips anchor at the roster table's edge and grow OUTWARD (ally chips
 *  right-anchored growing leftward, enemy chips left-anchored growing
 *  rightward) with `white-space: nowrap`, so a chip whose content is wider
 *  than the window's reserved side pad runs past the window edge — and the
 *  page's `overflow: hidden` clips it flat: the rounded cap vanishes and,
 *  at worst, the numbers go with it. That is exactly what a two-seal chip
 *  looks like when the roster table sits close to the game window's left
 *  edge and `build_anchor` could not reserve the full side pad.
 *
 *  The fix trims before it clamps: seals drop first (composition seals
 *  before career verdicts — a comp seal repeats across the whole roster, a
 *  career verdict belongs to one player), and only when even the bare
 *  numbers cannot fit does the chip's free edge clamp to the window edge,
 *  trading a slight reach back over the table's outer column for keeping
 *  the numbers whole (the webview would otherwise clip them away). */

/** Sub-pixel overhang tolerance (CSS px): the anchor's physical→CSS
 *  division rounds, and costing a seal over a hairline clip is worse than
 *  the hairline itself. */
const FIT_TOLERANCE_PX = 1;

/** The composition seals — the first to go when a chip must shrink. */
const COMP_STAMP_KINDS = new Set(["air", "sub"]);

/** Pull every overflowing chip back inside the viewport width. Reads each
 *  chip's laid-out box (call after the chips are in the DOM) and mutates
 *  only the ones that cross their window edge: `viewportWidth` is the
 *  overlay window's CSS width (the same box `body { overflow: hidden }`
 *  clips at). */
export function fitChips(root: ParentNode, viewportWidth: number): void {
  for (const side of ["ally", "enemy"] as const) {
    const chips = root.querySelectorAll<HTMLDivElement>(`.overlay-chip--${side}`);
    for (const el of chips) {
      // Ally chips grow leftward (their free edge is the left one), enemy
      // chips grow rightward — each side overflows at its own window edge.
      const overflow = (): number => {
        const box = el.getBoundingClientRect();
        return side === "ally" ? -box.left : box.right - viewportWidth;
      };
      if (overflow() <= FIT_TOLERANCE_PX) continue;
      // Seals drop in value order: composition (air/sub) first, career
      // verdicts last. Each removal re-measures — only the seals the room
      // actually demands come off.
      const comp: HTMLImageElement[] = [];
      const career: HTMLImageElement[] = [];
      for (const img of el.querySelectorAll<HTMLImageElement>("img.overlay-stamp[data-stamp]")) {
        (COMP_STAMP_KINDS.has(img.dataset.stamp ?? "") ? comp : career).push(img);
      }
      for (const img of [...comp, ...career]) {
        if (overflow() <= FIT_TOLERANCE_PX) break;
        img.remove();
      }
      if (overflow() <= FIT_TOLERANCE_PX) continue;
      // Bare numbers still overflow (a wide candidates range, a table
      // hugging the window edge): pin the chip's free edge to the window
      // edge. The chip keeps its width, so its anchored edge slides back
      // over the table's outer column by exactly the overflow amount —
      // strictly better than the webview clipping the numbers flat.
      if (side === "ally") {
        el.style.left = "0px";
        el.style.right = "auto";
      } else {
        el.style.left = "auto";
        el.style.right = "0px";
      }
    }
  }
}

/** Bitmap seals decode asynchronously: an unloaded seal <img> lays out at
 *  zero width, so the first render that carries seals measures narrower
 *  chips than the user ends up seeing — the trim pass can under-trim and
 *  the terminal state re-widens the chip back into the clip (a decode
 *  shows the bitmap; a broken src shows the broken-image icon + alt text,
 *  which widens the chip just the same). Arm a one-shot re-fit per seal
 *  still loading on both terminal events — memory-cached seals are
 *  already `complete`, so steady state arms nothing; load and error are
 *  mutually exclusive per img; each fire re-measures the LIVE chips, so a
 *  re-render between arm and fire stays safe (the stale img's event just
 *  re-runs the pass over the new tree, no debounce needed). `viewport` is
 *  read at fire time — the width the window has THEN is the one that
 *  clips. */
export function refitWhenSealsSettle(root: ParentNode, viewport: () => number): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img.overlay-stamp[data-stamp]")) {
    if (img.complete) continue;
    const refit = (): void => fitChips(root, viewport());
    img.addEventListener("load", refit, { once: true });
    img.addEventListener("error", refit, { once: true });
  }
}
