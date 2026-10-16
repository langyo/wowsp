package com.langyo.wowsp

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var backWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Phone-shell system-bar AND soft-keyboard handling, applied to the
   * webview wry hands us.
   *
   * Android 15+ forces edge-to-edge, so the page lays out under the status
   * and navigation bars. The webui's SCSS pads by env(safe-area-inset-*),
   * but Android WebView only reports display CUTOUTs through those env()s —
   * on a bar-only screen (no notch) they are all 0 and the phone shell's
   * top bar (hamburger/gear) sat inside the status bar's touch region,
   * where taps never reach the app. Padding the webview by the real
   * WindowInsets moves the whole layout below the bars instead; the webview
   * is made transparent and the decor view carries a dark backing color so
   * the exposed strips read as part of the dark shell (a light-theme
   * status-bar strip stays dark — cosmetic only).
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    backWebView = webView

    webView.setBackgroundColor(Color.TRANSPARENT)
    window.decorView.setBackgroundColor(0xFF161B26.toInt())
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      applyBarInsets(v, insets)
      WindowInsetsCompat.CONSUMED
    }
    // The listener only fires on attach/refresh dispatches; apply the
    // current insets right away too (and on every resume) so the very
    // first frame already lays out below the bars.
    applyBarInsets(webView, ViewCompat.getRootWindowInsets(window.decorView))

    registerBackBridge(webView)
  }

  override fun onResume() {
    super.onResume()
    backWebView?.let { applyBarInsets(it, ViewCompat.getRootWindowInsets(window.decorView)) }
  }

  private fun applyBarInsets(view: View, insets: WindowInsetsCompat?) {
    if (insets == null) {
      Log.d("WoWSPInsets", "no root insets yet")
      return
    }
    val bars = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    // The IME is an inset of its own, and nothing shrinks the window for
    // us: enableEdgeToEdge turns decor-fits-system-windows off, so from
    // API 30 up `adjustResize` has no window resize to perform and the
    // keyboard would simply paint over the webview. The page therefore kept
    // its full layout height while the IME was up — the CSS viewport never
    // changed, so the phone sheets (capped at 100dvh minus the top inset)
    // stayed put and the field being typed into sat under the keyboard
    // (user report 2026-09-24: the create-player dialog's nickname box on
    // a narrow screen).
    //
    // Gated on API 30: below that the framework still honours the legacy
    // adjustResize and shrinks the window for the keyboard itself, so
    // applying the inset as well would leave the webview a keyboard short
    // twice over — a dead band above the IME. Below 30 the bars term alone
    // is what this app has always shipped.
    val imeBottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    } else {
      0
    }
    // max(), not sum: while the IME is up its inset already includes the
    // strip the navigation bar sits in, and adding both would leave a
    // nav-bar-tall gap above the keyboard.
    val bottom = maxOf(bars.bottom, imeBottom)
    Log.d(
      "WoWSPInsets",
      "t=${bars.top} b=${bars.bottom} ime=$imeBottom l=${bars.left} r=${bars.right}"
    )
    // WebView ignores View padding for web content (the page paints across
    // the padding), so inset the view itself through layout MARGINS — the
    // WebView then measures smaller and its CSS viewport shrinks to the
    // safe area. The margin strips show the decor view's dark backing.
    val lp = view.layoutParams
    if (lp is android.view.ViewGroup.MarginLayoutParams) {
      lp.topMargin = bars.top
      lp.bottomMargin = bottom
      lp.leftMargin = bars.left
      lp.rightMargin = bars.right
      view.layoutParams = lp
    }
  }

  /**
   * Android back-gesture bridge.
   *
   * wry registers its own back callback in WryActivity.setWebView
   * (canGoBack -> goBack, else finish the activity), but on the API 36
   * emulator that path exits the app even while the web layer has open
   * window surfaces: hikari's back guards keep marked history entries
   * (history.state.__hkBack) above the page base precisely so a back
   * gesture closes the topmost sheet/drawer instead of leaving the app.
   *
   * This callback is registered AFTER wry's (onWebViewCreate runs at the
   * end of setWebView), so it wins dispatcher priority and can decide
   * with the live page state instead of the bare WebView back/forward
   * list:
   *   1. a hikari back-guard marker is current -> history.back(), which
   *      pops the guard entry and closes the surface in the web layer;
   *   2. otherwise fall back to wry's own rule (canGoBack -> goBack,
   *      else finish) so plain pages still navigate back and the root
   *      view still exits.
   */
  private fun registerBackBridge(webView: WebView) {
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val wv = backWebView
          if (wv == null) {
            this@MainActivity.finish()
            return
          }
          wv.evaluateJavascript(
            """
            (function () {
              try {
                var s = window.history && window.history.state;
                if (s && typeof s === 'object' && s.__hkBack !== undefined) {
                  window.history.back();
                  return 'guard';
                }
              } catch (e) { /* fall through to the native rule */ }
              return null;
            })()
            """.trimIndent()
          ) { consumed ->
            Log.d(
              "WoWSPBack",
              "consumed=$consumed canGoBack=${wv.canGoBack()} url=${wv.url}"
            )
            if (consumed != "\"guard\"") {
              if (wv.canGoBack()) {
                wv.goBack()
              } else {
                this@MainActivity.finish()
              }
            }
          }
        }
      },
    )
  }
}
