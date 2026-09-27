/**
 * Sharing utilities for the post-battle panels (replay 结果 modal and the
 * live-view post-battle window): nickname masking (hide all / hide single
 * players) plus the "copy share shot" flow that renders the matrix to a
 * watermarked PNG and pushes it onto the system clipboard.
 *
 * Masking state is deliberately per-modal and ephemeral — it is a share-time
 * privacy choice, not a preference. The fixed-width mask is NOT
 * length-preserving: a nick's length is itself information.
 */
import { defineComponent, onBeforeUnmount, ref } from "vue";
import { Camera, Eye, EyeOff } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { api } from "@/api";
import { t } from "@/i18n";
import { renderPostBattleShot, type ShotModel } from "./postBattleShot";

/** Display replacement for a hidden nickname (fixed width, see header). */
export const NICK_MASK = "••••••";

/** Nickname masking state for one post-battle modal. `hideAll` masks every
 *  nick; per-name toggles ride on top and persist across hide-all flips. */
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
 *  Surfaces a short inline note ("copied" / "failed") instead of a toast so
 *  the feedback sits next to the button that caused it. */
export function useShareShot(getModel: () => ShotModel, getEl: () => HTMLElement | null) {
  const busy = ref(false);
  const note = ref<"done" | "failed" | null>(null);
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  function clearNoteLater() {
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note.value = null;
      noteTimer = null;
    }, 2600);
  }
  async function copyShot() {
    if (busy.value) return;
    busy.value = true;
    note.value = null;
    let ok = false;
    try {
      const bytes = await renderPostBattleShot(getModel(), {
        el: getEl(),
        tagline: t("replay.postbattle.shotTagline"),
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
            /* fall through to the failure note */
          }
        }
      }
    } catch {
      /* render failure — same failure note */
    }
    busy.value = false;
    note.value = ok ? "done" : "failed";
    clearNoteLater();
  }
  onBeforeUnmount(() => {
    if (noteTimer) clearTimeout(noteTimer);
  });
  return { busy, note, copyShot };
}

/** Toolbar riding the post-battle panel top: hide-all-nicknames toggle (with
 *  the per-row eye hint) and the copy-share-shot action with its inline
 *  result note. Shared by the results panel and the incomplete-results
 *  fallback so both post-battle windows expose the same share controls. */
export const PostBattleShareBar = defineComponent({
  name: "PostBattleShareBar",
  props: {
    hideAll: { type: Boolean, default: false },
    shotBusy: { type: Boolean, default: false },
    shotNote: { type: String as () => "done" | "failed" | null, default: null },
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
        <span
          class={[
            "replay-view__postbattle-shot-note",
            props.shotNote ? `replay-view__postbattle-shot-note--${props.shotNote}` : "",
          ]}
        >
          {props.shotNote === "done"
            ? t("replay.postbattle.copyShotDone")
            : props.shotNote === "failed"
              ? t("replay.postbattle.copyShotFailed")
              : ""}
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
