/**
 * WoWSP native-DOM custom title bar for the Tauri desktop shell.
 * Self-contained IIFE — runs before Vue mounts, self-guards in a plain browser.
 * Adapted from shittim-chest's tauri-titlebar (simplified: no circadian theme).
 */
(function () {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (!window.__TAURI__ || !window.__TAURI__.window) return;

  var win = window.__TAURI__.window.getCurrentWindow();
  var BAR_HEIGHT = 32;

  function resolveDarkMode() {
    var htmlMode = document.documentElement.getAttribute("data-mode");
    if (htmlMode === "dark") return true;
    if (htmlMode === "light") return false;
    var stored = localStorage.getItem("wowsp-theme-mode");
    if (stored === "dark") return true;
    if (stored === "light") return false;
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  }

  var style = document.createElement("style");
  style.id = "wowsp-titlebar-style";
  style.textContent =
    "#wowsp-titlebar{--tb-bg:rgba(18,24,38,0.6);--tb-border:rgba(255,255,255,0.06);--tb-fg:rgba(255,255,255,0.55);--tb-fg-strong:rgba(255,255,255,0.95);--tb-hover:rgba(255,255,255,0.10);--tb-active:rgba(255,255,255,0.16);--tb-focus:rgba(0,120,200,0.6)}" +
    "#wowsp-titlebar[data-theme-mode='light']{--tb-bg:rgba(245,248,252,0.75);--tb-border:rgba(0,0,0,0.08);--tb-fg:rgba(0,0,0,0.55);--tb-fg-strong:rgba(0,0,0,0.88);--tb-hover:rgba(0,0,0,0.06);--tb-active:rgba(0,0,0,0.10)}" +
    "#wowsp-titlebar{position:fixed;top:0;left:0;right:0;height:" + BAR_HEIGHT + "px;display:flex;align-items:center;z-index:100001;user-select:none;background:var(--tb-bg);backdrop-filter:blur(16px);border-bottom:1px solid var(--tb-border);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-app-region:drag;app-region:drag}" +
    "#wowsp-titlebar-right{-webkit-app-region:no-drag;app-region:no-drag;display:flex;align-items:center;height:100%}" +
    "#wowsp-titlebar-title{font-size:11px;font-weight:600;letter-spacing:0.02em;color:var(--tb-fg);padding-left:8px;white-space:nowrap;display:flex;align-items:center;gap:6px}" +
    "#wowsp-titlebar-logo{width:18px;height:18px;border-radius:3px;flex-shrink:0}" +
    "#wowsp-titlebar-spacer{flex:1}" +
    ".wowsp-caption-btn{width:46px;height:" + BAR_HEIGHT + "px;border:none;background:transparent;color:var(--tb-fg);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background-color .12s ease,color .12s ease;outline:none}" +
    ".wowsp-caption-btn:hover{background:var(--tb-hover);color:var(--tb-fg-strong)}" +
    ".wowsp-caption-btn:active{background:var(--tb-active)}" +
    ".wowsp-caption-btn--close:hover{background:#e81123;color:#fff}" +
    ".wowsp-caption-btn--close:active{background:#f1707a;color:#fff}" +
    ".wowsp-caption-btn:focus-visible{outline:2px solid var(--tb-focus);outline-offset:-2px}" +
    "html,body{margin:0!important;padding:0!important;overflow:hidden!important}" +
    "#app{position:absolute!important;top:" + BAR_HEIGHT + "px!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:auto!important;overflow:hidden!important}";
  document.head.appendChild(style);

  var MIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 12h14"/></svg>';
  var MAX_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
  var RESTORE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="8" width="13" height="13" rx="2"/><path d="M8 8V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3"/></svg>';
  var CLOSE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var bar = document.createElement("div");
  bar.id = "wowsp-titlebar";
  bar.innerHTML =
    '<span id="wowsp-titlebar-title"><img id="wowsp-titlebar-logo" src="/logo.webp" alt="" />WoWSP</span>' +
    '<span id="wowsp-titlebar-spacer"></span>' +
    '<div id="wowsp-titlebar-right">' +
    '<button type="button" class="wowsp-caption-btn" data-act="minimize" title="Minimize" aria-label="Minimize">' + MIN_SVG + '</button>' +
    '<button type="button" class="wowsp-caption-btn" data-act="toggle" title="Maximize" aria-label="Maximize">' + MAX_SVG + '</button>' +
    '<button type="button" class="wowsp-caption-btn wowsp-caption-btn--close" data-act="close" title="Close" aria-label="Close">' + CLOSE_SVG + '</button>' +
    '</div>';
  document.body.appendChild(bar);

  function applyTitlebarTheme() {
    bar.setAttribute("data-theme-mode", resolveDarkMode() ? "dark" : "light");
  }
  applyTitlebarTheme();

  var themeObserver = new MutationObserver(applyTitlebarTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  window.addEventListener("storage", function (e) {
    if (e.key === "wowsp-theme-mode") applyTitlebarTheme();
  });
  if (typeof matchMedia !== "undefined") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTitlebarTheme);
  }

  var titleEl = document.getElementById("wowsp-titlebar-title");
  if (titleEl) {
    var updateTitle = function () { titleEl.textContent = document.title || "WoWSP"; };
    updateTitle();
    var titleNode = document.querySelector("title");
    if (titleNode) {
      var mo = new MutationObserver(updateTitle);
      mo.observe(titleNode, { childList: true, characterData: true, subtree: true });
    }
  }

  function refreshMaximized() {
    var btn = bar.querySelector('[data-act="toggle"]');
    if (!btn) return;
    win.isMaximized().then(function (max) {
      btn.innerHTML = max ? RESTORE_SVG : MAX_SVG;
      btn.title = max ? "Restore" : "Maximize";
      btn.setAttribute("aria-label", max ? "Restore" : "Maximize");
    }).catch(function () {});
  }
  refreshMaximized();
  win.onResized(function () { refreshMaximized(); }).catch(function () {});

  bar.addEventListener("dblclick", function (e) {
    if (e.target && e.target.closest && e.target.closest(".wowsp-caption-btn")) return;
    win.toggleMaximize().catch(function () {});
  });

  bar.querySelector("#wowsp-titlebar-right").addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".wowsp-caption-btn") : null;
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "minimize") win.minimize().catch(function () {});
    else if (act === "toggle") win.toggleMaximize().catch(function () {});
    else if (act === "close") win.close().catch(function () {});
  });
})();
