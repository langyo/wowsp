import { bootRecoveryPlugin } from "@celestia-island/hikari/plugins/boot-recovery";

import type { Plugin } from "vite";

/**
 * Pre-boot origin self-heal for the main app window — the WoWSP WIRING.
 *
 * The implementation lives UPSTREAM in hikari since hikari #955 (published in
 * `@celestia-island/hikari` 0.55.249 as the `./plugins/boot-recovery`
 * subpath); this module is the thin host-side config WoWSP keeps in-tree so
 * `vite.config.ts` has one stable import and the host policy stays reviewable
 * in the host repo.
 *
 * WHY IT EXISTS (the 0.6.8 crash-recovery incident): WebView2's renderer died,
 * the shell's crash recovery reloaded the main window and it came back on
 * `http://tauri.localhostundefined/` — an origin that still serves
 * `index.html` (the embedded asset handler ignores the bogus host suffix) but
 * resolves every asset URL and the IPC channel against the wrong origin. The
 * module graph never loads, so the Vue app never mounts and the window sits on
 * the static "WoWSP loading…" placeholder forever. The published plugin
 * injects one classic inline script at the end of `index.html`'s `<head>`
 * (after the charset meta, so the 1024-byte encoding prescan still finds it):
 *
 *   1. ORIGIN HEAL — on a hostname that only starts with the app host, replace
 *      the location with the canonical origin; the window recovers by itself.
 *   2. BOOT WATCHDOG — after the deadline, if `#loading-screen` is still
 *      attached (i.e. `main.ts` never called `__loaderDismiss` after
 *      `app.mount`), replace its contents with hikari's shared error landing
 *      (`HkErrorLanding`: tone icon, headline, explanation and a primary
 *      reload action). The reload is user-triggered only — a broken build must
 *      never reload-loop.
 *
 * `index.html` is the ONLY WoWSP page it is injected into: it is the only one
 * with the static loading screen; `overlay.html` / `aimcard.html` /
 * `chat.html` / `tray.html` are bare shell-managed windows over the game, and
 * reloading a transparent overlay mid-battle is the wrong recovery. The
 * component defaults already match WoWSP's contract (`#loading-screen`, the
 * `hidden` dismissal class, `injectTo: "head"`), so only the host copy (now
 * carrying the panel's locale table) and the entry list need stating here.
 *
 * PANEL LOCALES (hikari #1056, published in 0.55.273; the landing card in
 * #1127 / 0.55.302): the failure panel resolves its copy through the plugin's
 * locale-source order — the host's saved UI locale first (localStorage
 * `wowsp-ui-locale`, the key `src/i18n/useLanguage.ts` reads and writes,
 * passed as `copy.storageKey`), then the shell OS preference
 * (`window.__WOWSP_OS_PREFS__`, seeded by the Tauri shell before page load —
 * `packages/app/tauri/src/os_prefs.rs` — passed as the top-level
 * `osPrefsGlobal` option so the plugin reads WoWSP's global instead of the
 * boot-chrome family default `__CELESTIA_OS_PREFS__`), then
 * `navigator.languages` / `navigator.language`, and finally the plain
 * English `title` / `message` / `retry` fallback fields. Candidate matching
 * walks exact tag → progressive trailing-subtag strip → primary subtag, with
 * table insertion order as the tie-break — hence zh-CN listed before zh-TW.
 * The table covers the eight UI locales plus the zh script/region variants a
 * navigator may emit (`zh-Hans` / `zh-Hant` / `zh-HK` / `zh-MO`): the
 * plugin strips candidate subtags only down to the primary language, so those
 * variants are pinned explicitly instead of falling through to the first zh
 * row. Terminology must stay aligned with the
 * res/i18n/locales/<locale>/common.json "reload" strings — the retry label IS
 * the app's reload verb.
 *
 * The headline/explanation split is the landing card's own contract (hikari
 * #1127): the title names the failure, the message explains it, and the retry
 * button is the action. The card's stylesheet is compiled from hikari's own
 * `HkErrorLanding`/`HkButton` sheets upstream, so nothing is styled here and
 * a hikari restyle flows into this panel without a host edit.
 *
 * The generated script is deterministic, ASCII-only and classic (non-module)
 * so the Tauri shell can hash it into the app CSP at compile time — see the
 * published plugin's docs for the full contract.
 */

/** zh-CN panel copy — shared verbatim with the `zh-Hans` alias row. */
const ZH_CN_COPY = {
  title: "WoWSP 未能完成加载",
  message: "应用窗口可能已从崩溃中恢复，重新加载通常可以解决问题。",
  retry: "重新加载",
};

/** zh-TW panel copy — shared verbatim with `zh-Hant` / `zh-HK` / `zh-MO`. */
const ZH_TW_COPY = {
  title: "WoWSP 未能完成載入",
  message: "應用程式視窗可能已從當機中復原，重新載入通常可以解決問題。",
  retry: "重新載入",
};

export function wowspBootRecovery(): Plugin {
  return bootRecoveryPlugin({
    htmlFiles: ["index.html"],
    osPrefsGlobal: "__WOWSP_OS_PREFS__",
    copy: {
      title: "WoWSP did not finish loading",
      message:
        "The app window may have recovered from a crash; reloading usually fixes it.",
      retry: "Reload",
      storageKey: "wowsp-ui-locale",
      locales: {
        "en-US": {
          title: "WoWSP did not finish loading",
          message:
            "The app window may have recovered from a crash; reloading usually fixes it.",
          retry: "Reload",
        },
        "zh-CN": ZH_CN_COPY,
        "zh-TW": ZH_TW_COPY,
        "ja-JP": {
          title: "WoWSP の読み込みが完了しませんでした",
          message:
            "アプリのウィンドウはクラッシュから復帰した可能性があります。再読み込みすると通常は解決します。",
          retry: "再読み込み",
        },
        "ko-KR": {
          title: "WoWSP가 로딩을 완료하지 못했습니다",
          message:
            "앱 창이 비정상 종료에서 복구되었을 수 있습니다. 새로 고침하면 대개 해결됩니다.",
          retry: "새로고침",
        },
        "ru-RU": {
          title: "WoWSP не завершил загрузку",
          message:
            "Окно приложения, возможно, восстановилось после сбоя; перезагрузка обычно устраняет проблему.",
          retry: "Перезагрузить",
        },
        "fr-FR": {
          title: "WoWSP n'a pas terminé de se charger",
          message:
            "La fenêtre de l'application s'est peut-être rétablie après un plantage ; recharger corrige généralement le problème.",
          retry: "Recharger",
        },
        "es-ES": {
          title: "WoWSP no terminó de cargarse",
          message:
            "Es posible que la ventana de la aplicación se haya recuperado de un fallo; recargar suele solucionarlo.",
          retry: "Recargar",
        },
        // Navigator aliases — the plugin strips candidate subtags only down
        // to the primary language, so the Han/region variants that should
        // NOT fall through to the first zh row are pinned explicitly:
        "zh-Hans": ZH_CN_COPY,
        "zh-Hant": ZH_TW_COPY,
        "zh-HK": ZH_TW_COPY,
        "zh-MO": ZH_TW_COPY,
      },
    },
  });
}
