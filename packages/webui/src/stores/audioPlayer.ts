/**
 * Global preview-audio engine — plays mod-hub voice lines and native
 * clips through one HTMLAudioElement whose lifetime is independent of
 * the pane that started playback (navigating away keeps it rolling).
 *
 * The user-facing surface is the stock hikari toast: while a track is
 * actually rolling, a sticky "正在播放" toast (loading type — duration 0)
 * rides the normal top-right toast column; pausing or stopping drops it
 * again. Errors surface as copyable error toasts. Track payloads arrive
 * as data URLs from the caller's loader callback — AssetPreview passes
 * the mod-hub asset read (which is also where the .wem → WAV decode
 * happens), keeping this store transport-agnostic.
 */
import { useToast } from "@celestia-island/hikari";
import { defineStore } from "pinia";
import { ref } from "vue";

import { t } from "@/i18n";

/** Element factory, swappable so tests can drive a stub element through
 *  the exact code path the app drives a real HTMLAudioElement. */
let createElement = (): HTMLAudioElement => new Audio();

/** Test seam for the factory above — production code never calls this. */
export function setAudioElementFactoryForTests(factory: () => HTMLAudioElement): void {
  createElement = factory;
}

export const useAudioPlayerStore = defineStore("audioPlayer", () => {
  const toast = useToast();

  /** A track is loaded (playing or paused) — raised by the first play
   *  request, dropped by stop and by natural end. */
  const active = ref(false);
  /** Payload fetch (the .wem decode round-trip) in flight. */
  const loading = ref(false);
  /** res_mods-relative path of the current track ("" = nothing loaded). */
  const rel = ref("");
  /** Display name (file name) of the current track. */
  const title = ref("");
  /** The element is rolling (not paused). */
  const playing = ref(false);

  // Deliberately non-reactive: nothing renders the element itself, and
  // keeping it out of the reactive graph avoids proxying a DOM node.
  let el: HTMLAudioElement | null = null;
  /** Message id of the sticky 正在播放 toast (null = not shown). */
  let playingToastId: number | null = null;
  /** Bumped by every play() request — stale loaders (superseded, or a
   *  same-rel retry after a stop swapped the element) die on it. */
  let session = 0;

  function showPlayingToast(): void {
    if (playingToastId === null) {
      playingToastId = toast.loading(t("resources.audioPlaying", { name: title.value }));
    }
  }

  function hidePlayingToast(): void {
    playingToastId = null;
    // hikari's remove() matches SLOT ids before message ids and the two
    // counters are independent — resolving the slot by type (this store
    // is the app's only toast.loading caller) can never unbind some
    // unrelated slot that happens to share the message id.
    const slot = toast.toasts.find((s) => s.type === "loading");
    if (slot) toast.remove(slot.id);
  }

  function ensureElement(): HTMLAudioElement {
    if (el) return el;
    const element = createElement();
    element.onplay = () => {
      playing.value = true;
      showPlayingToast();
    };
    element.onpause = () => {
      playing.value = false;
      hidePlayingToast();
    };
    element.onended = () => stop();
    element.onerror = () => {
      // stop() nulls the handlers before its empty-src load(), so this
      // only fires on a real decode failure of a served payload.
      const detail = element.error?.message || "decode failed";
      toast.error(`${t("resources.audioLoadFailed")}: ${detail}`);
      stop();
    };
    el = element;
    return element;
  }

  /** Tear the element down and clear every ref — stop(), natural end and
   *  failed loads all land here, which is also what drops the toast. */
  function stop(): void {
    hidePlayingToast();
    if (el) {
      el.onended = el.onerror = el.onplay = el.onpause = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    el = null;
    active.value = false;
    loading.value = false;
    playing.value = false;
    rel.value = "";
    title.value = "";
  }

  /**
   * Ask for a track. The same track toggles pause/resume; a new track
   * swaps immediately (the loader callback supplies its data URL — for
   * .wem that is the decode round-trip) and starts from zero. A
   * superseding request wins: stale loaders are discarded on both the
   * session token and the rel guard — the rel guard alone could not
   * stop a stopped-and-retried same-rel request from arming an orphaned
   * element. Load failures raise an error toast and close the session.
   */
  async function play(
    nextRel: string,
    nextTitle: string,
    load: () => Promise<string>,
  ): Promise<void> {
    if (active.value && rel.value === nextRel) {
      togglePlayPause();
      return;
    }
    const mySession = ++session;
    const element = ensureElement();
    element.pause(); // silence any still-rolling previous track at once
    rel.value = nextRel;
    title.value = nextTitle;
    active.value = true;
    playing.value = false;
    loading.value = true;
    try {
      const dataUrl = await load();
      if (mySession !== session || rel.value !== nextRel) return;
      element.src = dataUrl;
      await element.play();
    } catch (e) {
      if (mySession === session && rel.value === nextRel) {
        const detail = e instanceof Error ? e.message : String(e);
        toast.error(`${t("resources.audioLoadFailed")}: ${detail}`);
        stop();
      }
      return;
    }
    if (mySession === session && rel.value === nextRel) loading.value = false;
  }

  function togglePlayPause(): void {
    if (!el || !active.value || loading.value) return;
    if (el.paused) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }

  return { active, loading, rel, title, playing, play, stop };
});
