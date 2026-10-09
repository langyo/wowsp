/**
 * Popup chrome — declares the window's custom title bar as hikari's
 * popup-bounds band, so every floating surface (the global data-hint
 * tooltip, HkTooltip, popovers, select/menu popouts) positions itself
 * inside the space below the caption strip instead of over it. The band
 * is one developer-facing declaration (hikari popupBounds): the shell
 * owns the measurement here, the popups never re-measure the bar.
 *
 * The wrapper is display:contents (boxless — Chromium reports an
 * all-zero rect for it), so the real box is the fixed hikari bar root
 * inside it; a zero rect (bar hidden or absent, e.g. the tray surface)
 * clears the band. Re-measured on bar resize (the phone-layout raise,
 * caption row wraps) and window resize; cleared on teardown.
 */
import { configurePopupInsets } from "@celestia-island/hikari/runtime";

/** Declare the bar's real box as the popup chrome band; a bar without
 *  layout (zero rect) clears the band. */
export function syncChromeInsets(bar: HTMLElement | null): void {
  const bottom = bar?.getBoundingClientRect().bottom ?? 0;
  configurePopupInsets(bottom > 0 ? { top: bottom } : null);
}

/** Wire a title bar element to the popup bounds: declare on call,
 *  re-declare on bar box or window resize. Returns the teardown that
 *  disconnects and clears the band. */
export function watchChromeInsets(bar: HTMLElement): () => void {
  syncChromeInsets(bar);
  // Styles can land after mount (dev injects CSS post-hoc), so the very
  // first measure can be a pre-stylesheet transient — re-sync over the
  // next frames in addition to the observers below.
  let disposed = false;
  const resync = (): void => {
    if (!disposed) syncChromeInsets(bar);
  };
  const raf = requestAnimationFrame(() => {
    resync();
    requestAnimationFrame(resync);
  });
  const observer = new ResizeObserver(resync);
  observer.observe(bar);
  const onResize = resync;
  window.addEventListener("resize", onResize, { passive: true });
  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    observer.disconnect();
    window.removeEventListener("resize", onResize);
    syncChromeInsets(null);
  };
}
