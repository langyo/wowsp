/** Post-layout passes for the Tab overlay's chip layer.
 *
 *  KEEP EVERY ROW INSIDE THE WINDOW (fitChips): rows anchor at the roster
 *  table's edge and grow OUTWARD (allies right-anchored growing leftward,
 *  enemies left-anchored growing rightward) with `white-space: nowrap`, so
 *  a row whose content is wider than the window's reserved side pad runs
 *  past the window edge — and the page's `overflow: hidden` clips it flat:
 *  the rounded cap vanishes and, at worst, the content goes with it. That
 *  is exactly what a two-seal row looks like when the roster table sits
 *  close to the game window's left edge and `build_anchor` could not
 *  reserve the full side pad.
 *
 *  The fix trims before it clamps: seals drop first (composition seals
 *  before career verdicts — a comp seal repeats across the whole roster, a
 *  career verdict belongs to one player), and only when even the bare
 *  numbers cannot fit does the row's free edge clamp to the window edge,
 *  trading a slight reach back over the table's outer column for keeping
 *  the numbers whole (the webview would otherwise clip them away).
 *
 *  ALIGN THE STAT COLUMN (alignStatColumns): every row carries a stat cell
 *  against the table edge and a name cell outside it; the cells must line
 *  up across rows for the two-column read (enemies: numbers right-aligned,
 *  names left-aligned; allies mirrored). Row elements are individually
 *  anchored, so the columns align only when every stat cell shares ONE
 *  width — measured here as the widest face on the side, which pins the
 *  enemy name column's START and the ally name column's END to a fixed
 *  x. */

/** Sub-pixel overhang tolerance (CSS px): the anchor's physical→CSS
 *  division rounds, and costing a seal over a hairline clip is worse than
 *  the hairline itself. */
const FIT_TOLERANCE_PX = 1;

/** The composition seals — the first to go when a chip must shrink. The
 *  veteran tiers (airVeteran / subVeteran — 空中奶龙 / 水下奶蛙) belong here
 *  with the minor tags: they are composition seals too (a >50% share face
 *  that replaces the minor one), so they trim FIRST. The MERGED seals
 *  (airMiracle / subMiracle / airApe / subApe — 空中神人 / 水下神人 /
 *  空中小猴 / 水下小猴) are deliberately ABSENT: they are the loudest
 *  verdict a chip can carry (a composition tag AND a career verdict at
 *  once) and must drop last, after the pure comp tags and alongside/after
 *  the career verdicts below — the bare string here would make a shrinking
 *  chip shed its strongest answer first. */
const COMP_STAMP_KINDS = new Set(["air", "sub", "airVeteran", "subVeteran"]);

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
      // actually demands come off. (Text seals and custom-picture <img>s
      // alike carry the data-stamp hook.)
      const comp: HTMLElement[] = [];
      const career: HTMLElement[] = [];
      for (const seal of el.querySelectorAll<HTMLElement>(".overlay-stamp[data-stamp]")) {
        (COMP_STAMP_KINDS.has(seal.dataset.stamp ?? "") ? comp : career).push(seal);
      }
      for (const seal of [...comp, ...career]) {
        if (overflow() <= FIT_TOLERANCE_PX) break;
        seal.remove();
      }
      if (overflow() <= FIT_TOLERANCE_PX) continue;
      // The bare row still overflows (a table hugging the window edge):
      // pin the chip's free edge to the window edge. The chip keeps its
      // anchored edge, so its free edge slides back over the table's outer
      // column by exactly the overflow amount — strictly better than the
      // webview clipping the content flat.
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

/** Pin each side's stat column to ONE width — the widest face among that
 *  side's rows — so the numbers sit on a single alignment line and the
 *  name column starts at a fixed x (the two-column contract of the row
 *  layout in overlay/main.ts). Call after the rows are in the DOM (real
 *  layout) and before {@link fitChips}, which measures the pinned widths.
 *  Every cell joins the width even when its own face is empty (a row with
 *  the numbers off must keep the column slot, or its name cell would slide
 *  out of the column). Lays out as zero width under happy-dom, so a
 *  test-environment measure (width 0 everywhere) skips the pass. */
export function alignStatColumns(root: ParentNode): void {
  for (const side of ["ally", "enemy"] as const) {
    const cells = root.querySelectorAll<HTMLElement>(
      `.overlay-chip--${side} .overlay-chip__stat`,
    );
    let widest = 0;
    for (const cell of cells) widest = Math.max(widest, cell.getBoundingClientRect().width);
    if (widest <= 0) continue;
    const width = `${Math.ceil(widest)}px`;
    for (const cell of cells) cell.style.width = width;
  }
}

/** Custom seal PICTURES decode asynchronously: an unloaded seal <img> lays
 *  out at zero width, so the first render that carries one measures
 *  narrower chips than the user ends up seeing — the trim pass can
 *  under-trim and the terminal state re-widens the chip back into the clip
 *  (a decode shows the bitmap; a broken src shows the broken-image icon +
 *  alt text, which widens the chip just the same). Arm a one-shot re-fit
 *  per seal still loading on both terminal events — memory-cached seals
 *  are already `complete`, so steady state arms nothing; load and error
 *  are mutually exclusive per img; each fire re-measures the LIVE chips,
 *  so a re-render between arm and fire stays safe (the stale img's event
 *  just re-runs the pass over the new tree, no debounce needed). Text
 *  seals (the default face) settle at layout time and need nothing here.
 *  `viewport` is read at fire time — the width the window has THEN is the
 *  one that clips. */
export function refitWhenSealsSettle(root: ParentNode, viewport: () => number): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img.overlay-stamp[data-stamp]")) {
    if (img.complete) continue;
    const refit = (): void => fitChips(root, viewport());
    img.addEventListener("load", refit, { once: true });
    img.addEventListener("error", refit, { once: true });
  }
}
