/** The one webui error sink. Release builds carry no console, so failures
 *  the UI can recover from still need evidence: every message lands in the
 *  app log (the 问题反馈 bundle reads it) and — once per distinct message —
 *  in a standard error toast. Never throws: a throwing sink would recurse
 *  into the very handler raising it. */
import { useToast } from "@celestia-island/hikari";

import { api } from "@/api";
import { t } from "@/i18n";

/** Messages already surfaced — a render loop must not bury the UI in
 *  toasts (the first occurrence carries the diagnosis). */
const seen = new Set<string>();

/** Browser-internal resize-loop notices, not app failures: an observer
 *  callback resized content after the frame was painted and the engine
 *  dropped the delivery — a benign layout race with no user-actionable
 *  failure and no app state change. Both engine spellings are matched
 *  (Chromium/WebView2 and the older Firefox wording). Observed on
 *  ship-detail 装备选择 switches 2026-11: the tooltip chrome (popupChrome)
 *  legitimately resizes while the modal remounts, so every ship switch
 *  raised the error toast for nothing. */
const BENIGN_RESIZE_LOOP =
  /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;

export function reportUiError(message: string, stack?: string) {
  const text = message || "unknown UI error";
  if (BENIGN_RESIZE_LOOP.test(text)) {
    // Dev-console breadcrumb only — no app log, no toast.
    // eslint-disable-next-line no-console
    console.debug("[wowsp] swallowed benign ResizeObserver loop notice:", text);
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[wowsp] UI error:", text, stack ?? "");
  void api.logUiError(text, stack);
  const key = text.slice(0, 200);
  if (seen.has(key)) return;
  seen.add(key);
  try {
    useToast().error(t("common.uiError", { message: key }));
  } catch {
    // The toast context itself failed — the log line above stays.
  }
}
