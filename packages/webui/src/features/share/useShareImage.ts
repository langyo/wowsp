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

export function useShareImage(
  render: () => Promise<Uint8Array>,
  opts: { signature?: () => string | number } = {},
) {
  const busy = ref(false);
  const toast = useToast();
  /** The last rendered shot and the content signature it was made from.
   *  Re-clicking the same content copies the cached bytes instead of
   *  re-rendering (the generating toast and the render cost only belong to
   *  the first click); a changed signature = different content = render
   *  again. */
  let cached: { bytes: Uint8Array; sig: string | number | null } | null = null;
  const signature = () => (opts.signature ? opts.signature() : null);
  async function copyToClipboard(bytes: Uint8Array): Promise<boolean> {
    try {
      await api.copyImageToClipboard(bytes);
      return true;
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
          return true;
        } catch {
          /* fall through to the failure toast */
        }
      }
      return false;
    }
  }
  async function copyShot(): Promise<void> {
    if (busy.value) return;
    const sig = signature();
    if (cached && cached.sig === sig) {
      const ok = await copyToClipboard(cached.bytes);
      if (ok) toast.success(t("share.copyShotDone"));
      else toast.error(t("share.copyShotFailed"), false);
      return;
    }
    busy.value = true;
    // Every generation announces itself first — the render can take seconds
    // and a silent button reads as dead.
    toast.info(t("share.copyShotGenerating"));
    let bytes: Uint8Array | null = null;
    try {
      bytes = await render();
    } catch {
      bytes = null;
    }
    busy.value = false;
    if (!bytes) {
      toast.error(t("share.copyShotFailed"), false);
      return;
    }
    // The render SUCCEEDED: keep the bytes even when the clipboard write
    // fails — the next click retries the copy without paying for the render.
    cached = { bytes, sig };
    if (await copyToClipboard(bytes)) toast.success(t("share.copyShotDone"));
    else toast.error(t("share.copyShotFailed"), false);
  }
  return { busy, copyShot };
}
