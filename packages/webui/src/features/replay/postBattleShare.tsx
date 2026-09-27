/**
 * Sharing utilities for the post-battle panels (replay 结果 modal and the
 * incomplete-results fallback matrix) and the live battle panel's head
 * actions: nickname masking (hide all / hide single players) plus the
 * "copy share shot" flow that renders the matrix to a watermarked PNG and
 * pushes it onto the system clipboard.
 *
 * Masking state is deliberately per-view and ephemeral — it is a share-time
 * privacy choice, not a preference. The fixed-width mask is NOT
 * length-preserving: a nick's length is itself information.
 */
import { defineComponent, ref } from "vue";
import { Camera, Eye, EyeOff } from "@lucide/vue";
import { HkSpinner, useToast } from "@celestia-island/hikari";

import { api } from "@/api";
import { t } from "@/i18n";
import { renderPostBattleShot, type ShotModel } from "./postBattleShot";

/** Display replacement for a hidden nickname (fixed width, see header). */
export const NICK_MASK = "••••••";

/** Nickname masking state for one masked view (a post-battle modal, or the
 *  live panel's head actions). `hideAll` masks every nick; per-name toggles
 *  ride on top and persist across hide-all flips. */
export function useNickMasking() {
  const hideAll = ref(false);
  const hiddenNames = ref(new Set<string>());
  const isHidden = (name: string) =>
    hideAll.value || hiddenNames.value.has(name);
  function toggleAll() {
    hideAll.value = !hideAll.value;
  }
  function toggleOne(name: string) {
    // Replace the Set so Vue's reactivity sees the change (Set mutation in
    // place would not trigger the render).
    const next = new Set(hiddenNames.value);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    hiddenNames.value = next;
  }
  /** Row display name: the mask when hidden, the raw nick otherwise. */
  const maskOf = (name: string) => (isHidden(name) ? NICK_MASK : name);
  return { hideAll, hiddenNames, isHidden, toggleAll, toggleOne, maskOf };
}

/** Copy flow for the share shot: renders the model off-DOM, then copies the
 *  PNG to the clipboard — native IPC first (arboard on desktop), the
 *  webview's async clipboard API as the fallback (mobile / browser hosts).
 *  Feedback rides the app's global toast surface (the inline note by the
 *  button was retired — a toast can't shift the toolbar layout). */
export function useShareShot(getModel: () => ShotModel, getEl: () => HTMLElement | null) {
  const busy = ref(false);
  const toast = useToast();
  async function copyShot() {
    if (busy.value) return;
    busy.value = true;
    let ok = false;
    try {
      const bytes = await renderPostBattleShot(getModel(), {
        el: getEl(),
        tagline: t("replay.postbattle.shotTagline"),
        disclaimer1: t("replay.postbattle.shotDisclaimer1"),
        disclaimer2: t("replay.postbattle.shotDisclaimer2"),
        qqGroup: t("replay.postbattle.shotQqGroup", { n: t("about.qqGroupNumber") }),
      });
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
    if (ok) toast.success(t("replay.postbattle.copyShotDone"));
    else toast.error(t("replay.postbattle.copyShotFailed"), false);
  }
  return { busy, copyShot };
}

/** Toolbar riding the post-battle panel top: hide-all-nicknames toggle (with
 *  the per-row eye hint) and the copy-share-shot action. Shared by the
 *  results panel and the incomplete-results fallback so both post-battle
 *  windows expose the same share controls. */
export const PostBattleShareBar = defineComponent({
  name: "PostBattleShareBar",
  props: {
    hideAll: { type: Boolean, default: false },
    shotBusy: { type: Boolean, default: false },
  },
  emits: ["toggleAll", "shot"],
  setup(props, { emit }) {
    return () => (
      <div class="replay-view__postbattle-toolbar">
        <button
          class={[
            "replay-view__postbattle-tool",
            { "replay-view__postbattle-tool--on": props.hideAll },
          ]}
          type="button"
          onClick={() => emit("toggleAll")}
        >
          {props.hideAll ? <Eye size={13} /> : <EyeOff size={13} />}
          {props.hideAll
            ? t("replay.postbattle.showAll")
            : t("replay.postbattle.hideAll")}
        </button>
        <span class="replay-view__postbattle-toolbar-hint">
          {t("replay.postbattle.maskHint")}
        </span>
        <button
          class="replay-view__postbattle-tool replay-view__postbattle-tool--shot"
          type="button"
          disabled={props.shotBusy}
          onClick={() => emit("shot")}
        >
          {props.shotBusy ? <HkSpinner size="xs" tone="current" /> : <Camera size={13} />}
          {t("replay.postbattle.copyShot")}
        </button>
      </div>
    );
  },
});
