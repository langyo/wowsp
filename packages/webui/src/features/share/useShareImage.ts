/**
 * Generic copy-share-shot flow shared by every share surface (the replay
 * post-battle matrix, the water-table stats cards, the clan roster card):
 * the caller's renderer produces PNG bytes off-DOM, then the bytes go to
 * the clipboard — native IPC first (arboard on desktop), the webview's
 * async clipboard API as the fallback (mobile / browser hosts). Feedback
 * rides the app's global toast surface (the inline note by the button was
 * retired — a toast can't shift the toolbar layout).
 */
import { ref } from "vue";
import { useToast } from "@celestia-island/hikari";

import { api } from "@/api";
import { t } from "@/i18n";

export function useShareImage(render: () => Promise<Uint8Array>) {
  const busy = ref(false);
  const toast = useToast();
  async function copyShot() {
    if (busy.value) return;
    busy.value = true;
    let ok = false;
    try {
      const bytes = await render();
      try {
        await api.copyImageToClipboard(bytes);
        ok = true;
      } catch {
        // Native path unavailable (mobile marker / non-Tauri host): the
        // webview clipboard API still accepts PNG blobs on many hosts.
        if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({
                "image/png": new Blob([bytes.slice().buffer], { type: "image/png" }),
              }),
            ]);
            ok = true;
          } catch {
            /* fall through to the failure toast */
          }
        }
      }
    } catch {
      /* render failure — same failure toast */
    }
    busy.value = false;
    if (ok) toast.success(t("share.copyShotDone"));
    else toast.error(t("share.copyShotFailed"), false);
  }
  return { busy, copyShot };
}
