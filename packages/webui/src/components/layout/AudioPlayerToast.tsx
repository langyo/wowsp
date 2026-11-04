import { defineComponent, onMounted, ref, watch } from "vue";
import { Pause, Play, Volume2, X } from "@lucide/vue";
import { HkIconButton, HkSpinner } from "@celestia-island/hikari";

import ToastCardBase, { type ToastCardBaseInstance } from "./ToastCardBase";
import { t } from "@/i18n";
import { useAudioPlayerStore } from "@/stores/audioPlayer";
import "./AudioPlayerToast.scss";

/**
 * AudioPlayerToast — the preview-audio controller card raised by the
 * audioPlayer store whenever a voice-line / audio preview starts playing.
 * hikari toasts support neither a progress bar nor custom actions, but a
 * player needs both — hence this shell-level card, thin store wiring over
 * ToastCardBase: the composite message row carries the name (flexes,
 * ellipsized, mono) and a pinned `0:12/2:34` next to the controls, and
 * the 4px seek rail below doubles as the drag-to-scrub surface (its
 * padded hit area and deliberately transition-free fill stay card-local;
 * indeterminate slide while the .wem decode round-trip is in flight).
 * Controls: stock hikari ghost HkIconButtons (play/pause, stop — stop
 * closes the card), re-tinted white for the card's surface.
 *
 * The store tearing down plays a leave transition instead of snapping
 * away (delayed unmount + frozen snapshot in the base). Renders nothing
 * while the store is idle, so it is safe to keep mounted unconditionally
 * at the shell level.
 */
export default defineComponent({
  name: "AudioPlayerToast",
  setup() {
    const player = useAudioPlayerStore();
    const card = ref<ToastCardBaseInstance | null>(null);

    /** Frozen track state served while the leave transition runs. */
    const held = ref({ title: "", playing: false, loading: false, position: 0, duration: 0 });
    // Seek-drag state (declared before the watcher below, which resets
    // it on the falling edge).
    const trackEl = ref<HTMLElement | null>(null);
    let seeking = false;

    /** One active-flip evaluation — the sync watcher and the mount
     *  replay (the immediate watcher fires before the base ref binds)
     *  share it. */
    function applyActive(active: boolean) {
      if (active) {
        // A new track mid-leave cancels the pending unmount and
        // restores the live card.
        card.value?.show();
      } else if (card.value?.shown && !card.value.leaving) {
        // A track swap can land mid-seek-drag: the dragged track node
        // is about to fold away with the pointer still captured, so
        // its pointerup will never fire — drop the flag here or plain
        // hovers over the next track's bar would keep seeking.
        seeking = false;
        held.value = {
          title: player.title,
          playing: player.playing,
          loading: player.loading,
          position: player.position,
          duration: player.duration,
        };
        card.value.dismiss();
      }
    }

    watch(
      () => player.active,
      applyActive,
      // Sync so the snapshot samples the still-live track state at the
      // active flip — the store clears its fields in the same block.
      { immediate: true, flush: "sync" },
    );

    // Replay the live state once the base card's ref exists — a track
    // already active at mount raises the card on the same clock the
    // setup-time watcher used to.
    onMounted(() => applyActive(player.active));

    /** m:ss — NaN/Infinity (no metadata yet) renders as 0:00. */
    function fmtTime(seconds: number): string {
      if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${String(s).padStart(2, "0")}`;
    }

    // --- seek bar: pointer press + capture, drag-to-scrub ---------------

    function ratioAt(e: PointerEvent): number {
      const rect = trackEl.value?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    }

    function onPointerDown(e: PointerEvent) {
      if (!player.duration || player.loading) return;
      seeking = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      player.seekRatio(ratioAt(e));
    }

    function onPointerMove(e: PointerEvent) {
      // Buttons check: a stale `seeking` flag must never turn a plain
      // hover into a seek (the flag can survive a drag whose pointerup
      // was swallowed by a track swap).
      if (seeking && e.buttons !== 0) player.seekRatio(ratioAt(e));
    }

    function onPointerUp() {
      seeking = false;
    }

    return () => {
      // Live store while active; the frozen snapshot while folding out.
      const live = player.active;
      const title = live ? player.title : held.value.title;
      const playing = live ? player.playing : held.value.playing;
      const loading = live ? player.loading : held.value.loading;
      const position = live ? player.position : held.value.position;
      const duration = live ? player.duration : held.value.duration;
      const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
      return (
        <ToastCardBase ref={card} tone="info" rootClass="audio-player-toast">
          {{
            icon: () => (loading ? <HkSpinner size="xs" tone="current" /> : <Volume2 size={14} />),
            message: () => (
              <>
                <span class="audio-player-toast__name">{title}</span>
                {duration > 0 ? (
                  <span class="audio-player-toast__time">
                    {fmtTime(position)}/{fmtTime(duration)}
                  </span>
                ) : null}
              </>
            ),
            trailing: () => (
              <div class="audio-player-toast__actions">
                <HkIconButton
                  size={24}
                  variant="ghost"
                  disabled={loading}
                  data-hint={playing ? t("resources.audioPause") : t("resources.audioResume")}
                  aria-label={playing ? t("resources.audioPause") : t("resources.audioResume")}
                  onClick={() => player.togglePlayPause()}
                >
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </HkIconButton>
                <HkIconButton
                  size={24}
                  variant="ghost"
                  data-hint={t("resources.audioStop")}
                  aria-label={t("resources.audioStop")}
                  onClick={() => player.stop()}
                >
                  <X size={16} />
                </HkIconButton>
              </div>
            ),
            progress: () => (
              <div
                ref={trackEl}
                class="audio-player-toast__seekbar"
                onPointerdown={onPointerDown}
                onPointermove={onPointerMove}
                onPointerup={onPointerUp}
                onPointercancel={onPointerUp}
              >
                <div class="audio-player-toast__track">
                  <div
                    class={["audio-player-toast__fill", loading && "audio-player-toast__fill--indeterminate"]}
                    style={!loading ? { width: `${pct}%` } : undefined}
                  />
                </div>
              </div>
            ),
          }}
        </ToastCardBase>
      );
    };
  },
});
