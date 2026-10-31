import { basename } from "node:path";

import { bootChromePlugin } from "@celestia-island/hikari/plugins/boot-chrome";
import type { Plugin } from "vite";

/**
 * hikari's pre-boot window chrome bar, wired for WoWSP's multi-window shell,
 * plus the host-side skin that brands it.
 *
 * WHY THIS MODULE EXISTS (rather than inline options in `vite.config.ts`):
 * `WEBUI_PAGES` below is the single list of HTML entries this package builds,
 * and `vite.config.ts` derives BOTH `build.rollupOptions.input` and the
 * boot-chrome plugin list from it. Keeping the table here lets
 * `src/bootChrome.test.ts` (a) catch a new page that was added to the package
 * but never classified as app window / shell-managed window, (b) exercise the
 * bar against the really-installed hikari plugin, and (c) assert — with a
 * source-level guard — that `vite.config.ts` actually consumes this list
 * instead of a stale copy.
 *
 * The bar itself is hikari's `res/boot-chrome.js`: it draws minimize /
 * maximize / close before this bundle exists, then removes itself as soon as
 * `AppTitleBar` (which wraps hikari's `HkTitleBar`) mounts and claims the
 * window with `hk:chrome-claim` — no WoWSP component change needed.
 *
 * hikari's plugin surface is `title` / `height` / `hangMs` / `htmlFiles` and
 * nothing else (checked against 0.55.224, the version this workspace pins): no
 * logo option, and no way to keep the initial "loading…" status out of the bar.
 * Dependencies are consumed as published (AGENTS.md §6), so the WoWSP look is
 * layered on from THIS side as one inline `<style>` — see
 * `wowspBootChromeSkin` below.
 *
 * The plugin deliberately warns once per skipped entry; on this repository that
 * is EXPECTED output (the four shell-managed windows are skipped on purpose),
 * not a misconfig.
 */

/** One HTML entry this package builds. */
export interface WebuiPage {
  /** Key in `rollupOptions.input` (the emitted entry chunk's name). */
  entry: string;
  /** The HTML file, next to the package root. */
  html: string;
  /**
   * Is this a real app window — the only kind the pre-boot bar may be
   * injected into? `false` = a shell-managed window: one of the transparent,
   * click-through pages the Rust side positions over the game, or the fixed
   * tray panel. The app does not paint a caption bar in those (a 32 px strip
   * floating over the game, or a bar on a window the shell itself owns).
   */
  bootChrome: boolean;
}

/**
 * Every page `rollupOptions.input` builds, and whether it is an app window.
 *
 * ADDING A PAGE IS A CONSCIOUS DECISION: `bootChrome` is a required field, so
 * a new entry cannot land without answering "does this window get the caption
 * bar?". `src/bootChrome.test.ts` fails if a package HTML file is missing from
 * this table, or if a page is reclassified without updating the expectation.
 */
export const WEBUI_PAGES = [
  { entry: "main", html: "index.html", bootChrome: true },
  // The AI battle report's secondary window (E25): a real app window with
  // the frameless title bar, spawned on demand by the replay view.
  { entry: "report", html: "report.html", bootChrome: true },
  { entry: "overlay", html: "overlay.html", bootChrome: false },
  { entry: "aimcard", html: "aimcard.html", bootChrome: false },
  { entry: "chat", html: "chat.html", bootChrome: false },
  { entry: "tray", html: "tray.html", bootChrome: false },
] as const satisfies readonly WebuiPage[];

/**
 * The entries the bar (and its host-side skin) are injected into — derived from
 * `WEBUI_PAGES`, never a hand-maintained copy. ONLY the main shell is an app
 * window.
 */
export const BOOT_CHROME_HTML_FILES: string[] = WEBUI_PAGES.filter(
  (page) => page.bootChrome,
).map((page) => page.html);

/**
 * The icon the pre-boot strip draws left of "WoWSP".
 *
 * The SAME url `App.tsx` hands `AppTitleBar` (`icon="/logo.webp"`): the strip
 * is a stand-in for the real title bar, so it must paint the asset the bar it
 * hands off to renders — anything else makes the handoff flash. Root-absolute
 * ON PURPOSE, exactly like App.tsx's prop: `vite.config.ts` sets `base: "/"`,
 * so "/…" is the app-root URL the Tauri webview resolves, and `src/res` is
 * this package's `publicDir`, so the build copies the asset to
 * `dist/webui/logo.webp` and the URL needs no rewriting.
 */
export const BOOT_CHROME_LOGO = "/logo.webp";

/**
 * Host-side skin for hikari's pre-boot bar — inline, in the app window's
 * `<head>`, so the strip is branded from its very first frame.
 *
 * WHY A SKIN AT ALL: see the module comment — hikari has no logo option and
 * creates #hk-boot-chrome-status with "loading…" unconditionally. The
 * supported seam is the bar's own DOM: this stylesheet targets its stable
 * #hk-boot-chrome-* ids.
 *
 * WHAT IT CHANGES:
 *
 *   1. Branding while loading — logo + "WoWSP" only. The centre of the screen
 *      already carries the real #loading-screen ("WoWSP loading…"), so a
 *      second loading label in the caption strip is noise. The geometry
 *      mirrors the real title bar (.hk-titlebar-title / .hk-titlebar-title-text):
 *      16 px icon, 8 px gap, 11 px / 600 / 0.04em text (the size and weight
 *      are inherited from the bar, which already sets them), so the handoff to
 *      AppTitleBar is visually invisible.
 *
 *   2. Failure copy preserved — the status span is NOT removed outright. The
 *      bar reports its own failure states there, and those are actionable: a
 *      refused window command (usually a missing ACL grant) degrades the bar to
 *      "window controls unavailable" (data-hk-degraded="1" on #hk-boot-chrome),
 *      and the 20 s boot watchdog marks the document
 *      data-hk-boot-chrome="hung" with "still loading…" plus a reload button.
 *      Hiding those would hide the only explanation of why the buttons are dead,
 *      so both states restore the span to normal flow (see ACCESSIBILITY).
 *
 *   3. One shared line box for mixed CJK/Latin copy — the bar is a flex row
 *      with align-items: center, which centres each item's OWN line box, and
 *      the CJK fallback font's line box is taller than the Latin one at 11 px:
 *      that is why "WoWSP 正在加载…" sat vertically off-centre in the reported
 *      screenshot. Pinning the name and the status to the same 16 px
 *      line-height gives them one shared line-box height, so a CJK status next
 *      to the Latin name can no longer skew the visual centre. (Invisible while
 *      the status is visually clipped; the fix for the states where it is
 *      restored to flow.)
 *
 * ACCESSIBILITY: the status span is role="status" — a live region. It must
 * stay IN the accessibility tree while the strip loads: a plain display: none
 * would drop the element (and its announcements) entirely, which is why this
 * skin uses the standard visually-hidden clip pattern instead — clipped to a
 * 1 px box and out of layout, yet still exposed to assistive technology. The
 * two failure-state rules restore it to normal flow, so the bar's failure copy
 * becomes visible; because hikari mutates the text of that live region when a
 * failure is reported, the mutation announces through role="status" as usual.
 * (No over-claim: this keeps the mechanism available — screen-reader support
 * for live regions still depends on the platform's own behaviour.)
 *
 * CASCADE: hikari appends its own <style> when its script runs — i.e. after
 * this head tag — and that sheet does own a few of the status' properties
 * (overflow/ellipsis, colour, weight, letter-spacing). The rules below either
 * set properties it does not touch or, where they overlap (the visually-hidden
 * `overflow: hidden`, undone by the restore), outrank it by specificity: the
 * failure selectors are two ids + an attribute against its single id, so the
 * cascade order hikari imposes cannot re-clip the restored span.
 */
export const BOOT_CHROME_SKIN_CSS = `/* --- branding: logo + name, mirroring .hk-titlebar-title --------------- */
#hk-boot-chrome-app {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  line-height: 16px;
  letter-spacing: 0.04em;
}
/* The same 16 px box AppTitleBar renders its \`icon\` in (.hk-titlebar-icon). */
#hk-boot-chrome-app::before {
  content: "";
  width: 16px;
  height: 16px;
  flex: none;
  background: url("${BOOT_CHROME_LOGO}") center / contain no-repeat;
}

/* --- loading state: branding only, status visually hidden --------------
   #loading-screen already says "WoWSP loading…", so the caption label would
   only repeat it — visually. The span is role="status" (a live region): a
   plain display: none would ALSO drop it and its failure announcements out of
   the accessibility tree, so use the standard visually-hidden clip pattern —
   out of layout and invisible, still exposed to assistive technology. Never
   set display here (and never display: none: it is the a11y regression this
   pattern exists to avoid). */
#hk-boot-chrome-status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
  /* Shared line box with the name — see WHY item 3. */
  line-height: 16px;
}

/* --- failure states: restore the actionable copy to normal flow --------
   degraded = no usable shell API, or a window command was refused (usually a
   missing ACL grant); hung = the boot watchdog fired (the bar also grows its
   reload button). Both must stay VISIBLE and readable: undo every clip
   declaration above and put the span back in the flex row (no display
   override), keeping the shared 16 px line box so CJK copy lines up with the
   Latin name. The selector list outranks hikari's single-id runtime rule, so
   its overflow/ellipsis cannot re-clip the restored span — see CASCADE. */
#hk-boot-chrome[data-hk-degraded="1"] #hk-boot-chrome-status,
html[data-hk-boot-chrome="hung"] #hk-boot-chrome-status {
  position: static;
  width: auto;
  height: auto;
  margin: 0;
  overflow: visible;
  clip: auto;
  clip-path: none;
}
`;

/**
 * Should the skin be injected into this HTML entry?
 *
 * Mirrors hikari's own filename matching so the bar and its skin can never
 * disagree about which windows are app windows: a string list is matched
 * against the basename or the path suffix ("pages/index.html"), and an absent
 * filename counts as the main entry (hikari treats a non-standard caller that
 * way rather than silently dropping the bar).
 */
function htmlFileMatches(filename: string | undefined): boolean {
  if (!filename) return true;
  const name = basename(filename);
  return BOOT_CHROME_HTML_FILES.some(
    (entry) => entry === name || filename === entry || filename.endsWith(`/${entry}`),
  );
}

/**
 * The host-side skin as a Vite plugin — one inline `<style>` in the head of
 * the app window(s) only, returning nothing for every shell-managed entry.
 *
 * Inline rather than an emitted .css file: the bar must be branded before any
 * second request can resolve (and there is no extra file that could 404). No
 * `apply: 'build'` — dev serves the same HTML through this hook and the
 * branded strip must not exist only in production.
 */
export function wowspBootChromeSkin(): Plugin {
  return {
    name: "wowsp-boot-chrome-skin",

    transformIndexHtml(_html, ctx) {
      const filename = ctx && typeof ctx.filename === "string" ? ctx.filename : "";
      if (!htmlFileMatches(filename)) return [];
      return [
        {
          tag: "style",
          attrs: { "data-wowsp-boot-chrome-skin": "" },
          children: BOOT_CHROME_SKIN_CSS,
          injectTo: "head",
        },
      ];
    },
  };
}

/** The plugin instance for `vite.config.ts`. */
export function wowspBootChrome(): Plugin {
  return bootChromePlugin({
    title: "WoWSP",
    // Only the app windows from the table above. Listing a shell-managed window
    // (transparent overlay or tray panel) here puts a caption bar inside it, so
    // a new page must be a conscious decision.
    htmlFiles: [...BOOT_CHROME_HTML_FILES],
  });
}

/**
 * The boot-chrome plugins for one build — EMPTY on the Android bundle.
 *
 * Desktop gets BOTH halves, in build order: hikari's bar, then the host-side
 * skin that brands it. The skin is meaningless without the bar (there is no
 * #hk-boot-chrome to style), so the Android gate covers the pair, not just the
 * bar.
 *
 * `WOWSP_MOBILE_BUNDLE=1` builds the APK, which runs inside a phone shell that
 * owns its own window: tao's Android minimize/maximize are no-ops, and the
 * phone UI hides the caption buttons (`AppTitleBar` drops them when
 * `isMobileApp()`), so injecting the desktop three-button bar there would paint
 * DEAD controls over the app from the first frame. Desktop keeps the bar before
 * the bundle exists — that is the whole point of the plugin.
 */
export function bootChromePluginsFor(mobileBundle: boolean): Plugin[] {
  return mobileBundle ? [] : [wowspBootChrome(), wowspBootChromeSkin()];
}
