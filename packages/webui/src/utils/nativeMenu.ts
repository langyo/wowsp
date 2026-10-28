/**
 * nativeMenu — the app-wide suppressor for the browser/WebView's OWN
 * context menu. Every WoWSP window is a desktop surface: the native
 * menu (Reload / Inspect / Save as…) must never appear, because it is
 * the casual route into the devtools. This runs in EVERY build (dev
 * included): the requirement is "彻底屏蔽", and keyboard shortcuts
 * (F12 / Ctrl+Shift+I) remain the developer's escape hatch where the
 * debug build enables devtools.
 *
 * BUBBLE phase on purpose: the app's own context menus bind on
 * document.body (hikari's HkContextMenuProvider). Body is a descendant
 * of document, so those bindings run FIRST, decide whether they open a
 * menu (and preventDefault the native one themselves), and only then
 * this listener runs — preventDefault is idempotent, so the platform
 * menu dies in every case while the app's own menus still open. A
 * CAPTURE listener here would run before the bindings, mark the event
 * defaultPrevented, and make hikari's inner-binding deferral logic
 * (the tactical board's canvas menu) think the event was consumed —
 * the player right-click menu would never open.
 */
export function installNativeMenuBlock(doc: Document = document): () => void {
  const onContextMenu = (event: Event) => {
    event.preventDefault();
  };
  doc.addEventListener("contextmenu", onContextMenu);
  return () => doc.removeEventListener("contextmenu", onContextMenu);
}
