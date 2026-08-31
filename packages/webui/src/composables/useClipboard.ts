import { useClipboardWithToast, useToast } from "@celestia-island/hikari";
import { t } from "@/i18n";

/** Copy-to-clipboard with toast feedback. Thin wrapper over hikari's
 *  useClipboardWithToast with the app's localized default messages. */
export function useClipboard() {
  const toast = useToast();
  const { copy } = useClipboardWithToast(
    toast,
    () => t("common.copied"),
    () => t("common.copyFailed"),
  );
  return { copy };
}
