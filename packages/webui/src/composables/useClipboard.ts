import { useClipboard as useVueClipboard } from "@vueuse/core";
import { useToast } from "./useToast";
import { t } from "@/i18n";

/** Copy-to-clipboard with toast feedback. Wraps @vueuse/core's useClipboard
 *  with legacy fallback + a success/error toast. */
export function useClipboard() {
  const { copy: rawCopy } = useVueClipboard({ legacy: true, copiedDuring: 1500 });
  const toast = useToast();

  async function copy(text: string, successMessage?: string) {
    try {
      await rawCopy(text);
      toast.success(successMessage ?? t("common.copied"));
    } catch {
      toast.error(t("common.copyFailed"));
    }
  }

  return { copy };
}
