"use strict";
(() => {
  // scripts/tauri-titlebar.ts
  try {
    let resolveDarkMode2 = function() {
      const htmlMode = document.documentElement.getAttribute("data-mode");
      if (htmlMode === "dark") return true;
      if (htmlMode === "light") return false;
      const stored = localStorage.getItem("wowsp-theme-mode");
      if (stored === "dark") return true;
      if (stored === "light") return false;
      return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
    }, applyTitlebarTheme2 = function() {
      bar.setAttribute("data-theme-mode", resolveDarkMode2() ? "dark" : "light");
    }, refreshMaximized2 = function() {
      const btn = bar.querySelector('[data-act="toggle"]');
      if (!btn) return;
      win.isMaximized().then((max) => {
        btn.innerHTML = max ? RESTORE_SVG : MAX_SVG;
        btn.title = max ? "Restore" : "Maximize";
        btn.setAttribute("aria-label", max ? "Restore" : "Maximize");
      }).catch(() => {
      });
    };
    resolveDarkMode = resolveDarkMode2, applyTitlebarTheme = applyTitlebarTheme2, refreshMaximized = refreshMaximized2;
    const tauri = window.__TAURI__;
    if (!tauri?.window) throw new Error("not tauri");
    if (!("__TAURI_INTERNALS__" in window)) throw new Error("not tauri");
    const win = tauri.window.getCurrentWindow();
    const BAR_HEIGHT = 32;
    const style = document.createElement("style");
    style.id = "wowsp-titlebar-style";
    style.textContent = `
#wowsp-titlebar{
  --tb-bg: rgba(18,24,38,0.6);
  --tb-border: rgba(255,255,255,0.06);
  --tb-fg: rgba(255,255,255,0.55);
  --tb-fg-strong: rgba(255,255,255,0.95);
  --tb-hover: rgba(255,255,255,0.10);
  --tb-active: rgba(255,255,255,0.16);
  --tb-focus: rgba(0,120,200,0.6);
}
#wowsp-titlebar[data-theme-mode="light"]{
  --tb-bg: rgba(245,248,252,0.75);
  --tb-border: rgba(0,0,0,0.08);
  --tb-fg: rgba(0,0,0,0.55);
  --tb-fg-strong: rgba(0,0,0,0.88);
  --tb-hover: rgba(0,0,0,0.06);
  --tb-active: rgba(0,0,0,0.10);
}
#wowsp-titlebar{
  position:fixed;top:0;left:0;right:0;height:${BAR_HEIGHT}px;
  display:flex;align-items:center;z-index:100001;user-select:none;
  background:var(--tb-bg);backdrop-filter:blur(16px);
  border-bottom:1px solid var(--tb-border);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  -webkit-app-region:drag;app-region:drag;
}
#wowsp-titlebar-right{
  -webkit-app-region:no-drag;app-region:no-drag;
  display:flex;align-items:center;height:100%;
}
#wowsp-titlebar-title{
  font-size:11px;font-weight:600;letter-spacing:0.02em;
  color:var(--tb-fg);padding-left:8px;white-space:nowrap;
  display:flex;align-items:center;gap:6px;
}
#wowsp-titlebar-logo{width:18px;height:18px;border-radius:3px;flex-shrink:0;pointer-events:none}
#wowsp-titlebar-spacer{flex:1}
.wowsp-caption-btn{
  width:46px;height:${BAR_HEIGHT}px;border:none;background:transparent;
  color:var(--tb-fg);cursor:pointer;display:flex;align-items:center;
  justify-content:center;transition:background-color .12s ease,color .12s ease;
  outline:none;
}
.wowsp-caption-btn:hover{background:var(--tb-hover);color:var(--tb-fg-strong)}
.wowsp-caption-btn:active{background:var(--tb-active)}
.wowsp-caption-btn--close:hover{background:#e81123;color:#fff}
.wowsp-caption-btn--close:active{background:#f1707a;color:#fff}
.wowsp-caption-btn:focus-visible{outline:2px solid var(--tb-focus);outline-offset:-2px}
html,body{margin:0!important;padding:0!important;overflow:hidden!important}
#app{position:absolute!important;top:${BAR_HEIGHT}px!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:auto!important;overflow:hidden!important}
`;
    document.head.appendChild(style);
    const MIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 12h14"/></svg>';
    const MAX_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
    const RESTORE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="8" width="13" height="13" rx="2"/><path d="M8 8V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3"/></svg>';
    const CLOSE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    const bar = document.createElement("div");
    bar.id = "wowsp-titlebar";
    bar.innerHTML = `<span id="wowsp-titlebar-title"><img id="wowsp-titlebar-logo" src="/logo.webp" alt="" />WoWSP</span><span id="wowsp-titlebar-spacer"></span><div id="wowsp-titlebar-right"><button type="button" class="wowsp-caption-btn" data-act="minimize" title="Minimize" aria-label="Minimize">${MIN_SVG}</button><button type="button" class="wowsp-caption-btn" data-act="toggle" title="Maximize" aria-label="Maximize">${MAX_SVG}</button><button type="button" class="wowsp-caption-btn wowsp-caption-btn--close" data-act="close" title="Close" aria-label="Close">${CLOSE_SVG}</button></div>`;
    document.body.appendChild(bar);
    applyTitlebarTheme2();
    const themeObserver = new MutationObserver(applyTitlebarTheme2);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-mode", "data-theme"]
    });
    window.addEventListener("storage", (e) => {
      if (e.key === "wowsp-theme-mode" || e.key === "wowsp-theme") {
        applyTitlebarTheme2();
      }
    });
    if (typeof matchMedia !== "undefined") {
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTitlebarTheme2);
    }
    refreshMaximized2();
    win.onResized(() => refreshMaximized2()).catch(() => {
    });
    bar.addEventListener("dblclick", (e) => {
      const target = e.target;
      if (target?.closest?.(".wowsp-caption-btn")) return;
      win.toggleMaximize().catch(() => {
      });
    });
    bar.querySelector("#wowsp-titlebar-right")?.addEventListener("click", (e) => {
      const target = e.target;
      const btn = target?.closest?.(".wowsp-caption-btn");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      if (act === "minimize") win.minimize().catch(() => {
      });
      else if (act === "toggle") win.toggleMaximize().catch(() => {
      });
      else if (act === "close") win.close().catch(() => {
      });
    });
  } catch {
  }
  var resolveDarkMode;
  var applyTitlebarTheme;
  var refreshMaximized;
})();
