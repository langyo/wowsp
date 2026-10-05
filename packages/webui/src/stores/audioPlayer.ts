/**
 * Global preview-audio engine — plays mod-hub voice lines and native
 * clips through one HTMLAudioElement whose lifetime is independent of
 * the pane that started playback (navigating away keeps it rolling).
 * The AudioPlayerToast card is the control surface (play/pause, seek,
 * stop); errors surface as copyable error toasts. Track payloads arrive
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

  /** Card visibility — raised by the first play request, dropped by stop
   *  and by natural end. */
  const active = ref(false);
  /** Payload fetch (the .wem decode round-trip) in flight — the card
   *  shows an indeterminate bar while this is true. */
  const loading = ref(false);
  /** res_mods-relative path of the current track ("" = nothing loaded). */
  const rel = ref("");
  /** Display name (file name) of the current track. */
  const title = ref("");
  /** The element is rolling (not paused). */
  const playing = ref(false);
  /** Playback position and total length, seconds. */
  const position = ref(0);
  const duration = ref(0);

  // Element and its frame ticker are deliberately non-reactive: nothing
  // renders either directly, and keeping them out of the reactive graph
  // avoids proxying DOM state.
  let el: HTMLAudioElement | null = null;
  /** Bumped by every play() request — stale loaders (superseded, or a
   *  same-rel retry after a stop swapped the element) die on it. */
  let session = 0;
  /** rAF id of the smooth-position ticker while the track rolls. */
  let rafId: number | undefined;

  /** The element's own `timeupdate` steps at ~4 Hz, which reads as a
   *  stuttering progress bar; while the track rolls, drive the position
   *  per frame instead (`timeupdate` still covers paused syncs). */
  function tick(): void {
    rafId = undefined;
    if (!el || el.paused) return;
    if (!loading.value) position.value = el.currentTime || 0;
    rafId = requestAnimationFrame(tick);
  }

  function startTicker(): void {
    if (rafId === undefined) rafId = requestAnimationFrame(tick);
  }

  function stopTicker(): void {
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId);
      rafId = undefined;
    }
  }

  function ensureElement(): HTMLAudioElement {
    if (el) return el;
    const element = createElement();
    element.ontimeupdate = () => {
      // The outgoing track's final timeupdate can land while the next
      // one is still loading (position already reset to 0) — don't let
      // it flash the old position on the loading card.
      if (!loading.value) position.value = element.currentTime || 0;
    };
    element.ondurationchange = () => {
      duration.value = Number.isFinite(element.duration) ? element.duration : 0;
    };
    element.onplay = () => {
      playing.value = true;
      startTicker();
    };
    element.onpause = () => {
      playing.value = false;
      stopTicker();
      // Settle on the element's exact resting spot (the last frame may
      // be up to one tick stale).
      if (!loading.value) position.value = element.currentTime || 0;
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
   *  failed loads all land here, which is also what closes the card. */
  function stop(): void {
    stopTicker();
    if (el) {
      el.onended = el.onerror = el.ontimeupdate = el.ondurationchange = el.onplay = el.onpause = null;
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
    position.value = 0;
    duration.value = 0;
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
    position.value = 0;
    duration.value = 0;
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

  /** Jump to an absolute time, clamped to the track. */
  function seek(seconds: number): void {
    if (!el || !active.value || loading.value || !duration.value) return;
    const clamped = Math.min(Math.max(seconds, 0), duration.value);
    el.currentTime = clamped;
    position.value = clamped;
  }

  /** Jump to a 0..1 ratio of the track — what the card's seek bar sends. */
  function seekRatio(ratio: number): void {
    seek(Math.min(Math.max(ratio, 0), 1) * duration.value);
  }

  return {
    active,
    loading,
    rel,
    title,
    playing,
    position,
    duration,
    play,
    togglePlayPause,
    seek,
    seekRatio,
    stop,
  };
});
