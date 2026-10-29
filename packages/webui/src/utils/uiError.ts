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

export function reportUiError(message: string, stack?: string) {
  const text = message || "unknown UI error";
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
