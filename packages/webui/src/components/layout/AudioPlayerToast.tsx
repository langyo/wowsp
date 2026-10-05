import { defineComponent, onBeforeUnmount, ref, Teleport, watch } from "vue";
import { Pause, Play, Volume2, X } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useAudioPlayerStore } from "@/stores/audioPlayer";
import "./AudioPlayerToast.scss";

/** Leave transition length — must match the --leave duration below. */
const LEAVE_MS = 260;

/**
 * AudioPlayerToast — the preview-audio controller card raised by the
 * audioPlayer store whenever a voice-line / audio preview starts playing.
 * hikari toasts support neither a progress bar nor custom actions, but a
 * player needs both — hence this shell-level card like the updater's
 * UpdateToast (same info-blue surface and z-band). Unlike UpdateToast it
 * docks BOTTOM-right in its own lane: playback spans whole voice lines,
 * and a top-right slot would cover the transient toast column for
 * minutes. Controls: play/pause, stop (closes the card), and a seek bar
 * (pointer drag while a track is loaded; indeterminate slide while the
 * .wem transcode round-trip is in flight).
 *
 * The store tearing down plays a leave transition instead of snapping
 * away (delayed unmount + frozen snapshot, the UpdateToast pattern), so
 * the folding card keeps its text and progress. Renders nothing while
 * the store is idle, so it is safe to keep mounted unconditionally at
 * the shell level.
 */
export default defineComponent({
  name: "AudioPlayerToast",
  setup() {
    const player = useAudioPlayerStore();

    const mounted = ref(false);
    const leaving = ref(false);
    /** Frozen track state served while the leave transition runs. */
    const held = ref({ title: "", playing: false, loading: false, position: 0, duration: 0 });
    let leaveTimer: number | undefined;
    // Seek-drag state (declared before the watcher below, which resets
    // it on the falling edge).
    const trackEl = ref<HTMLElement | null>(null);
    let seeking = false;

    watch(
      () => player.active,
      (active) => {
        if (active) {
          // A new track mid-leave cancels the pending unmount and
          // restores the live card.
          if (leaveTimer !== undefined) {
            window.clearTimeout(leaveTimer);
            leaveTimer = undefined;
          }
          leaving.value = false;
          mounted.value = true;
        } else if (mounted.value && !leaving.value) {
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
          leaving.value = true;
          leaveTimer = window.setTimeout(() => {
            leaveTimer = undefined;
            mounted.value = false;
            leaving.value = false;
          }, LEAVE_MS);
        }
      },
      // Sync so the snapshot samples the still-live pass state at the
      // active flip — the store clears its fields in the same block.
      { immediate: true, flush: "sync" },
    );

    onBeforeUnmount(() => {
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    });

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
      if (!mounted.value) return null;
      // Live store while active; the frozen snapshot while folding out.
      const live = player.active;
      const title = live ? player.title : held.value.title;
      const playing = live ? player.playing : held.value.playing;
      const loading = live ? player.loading : held.value.loading;
      const position = live ? player.position : held.value.position;
      const duration = live ? player.duration : held.value.duration;
      const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
      return (
        <Teleport to="body">
          <div class={["audio-player-toast", leaving.value ? "audio-player-toast--leave" : ""]} role="status">
            <div class="audio-player-toast__row">
              <span class="audio-player-toast__icon">
                {loading ? <HkSpinner size="xs" tone="current" /> : <Volume2 size={14} />}
              </span>
              <p class="audio-player-toast__title">{title}</p>
              <div class="audio-player-toast__actions">
                <button
                  type="button"
                  class="audio-player-toast__btn"
                  disabled={loading}
                  title={playing ? t("resources.audioPause") : t("resources.audioResume")}
                  onClick={() => player.togglePlayPause()}
                >
                  {playing ? <Pause size={13} /> : <Play size={13} />}
                </button>
                <button
                  type="button"
                  class="audio-player-toast__btn"
                  title={t("resources.audioStop")}
                  onClick={() => player.stop()}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
            <div class="audio-player-toast__seek">
              <span class="audio-player-toast__time">{fmtTime(position)}</span>
              <div
                ref={trackEl}
                class="audio-player-toast__track"
                onPointerdown={onPointerDown}
                onPointermove={onPointerMove}
                onPointerup={onPointerUp}
                onPointercancel={onPointerUp}
              >
                <div
                  class={[
                    "audio-player-toast__fill",
                    loading && "audio-player-toast__fill--indeterminate",
                  ]}
                  style={!loading ? { width: `${pct}%` } : undefined}
                />
              </div>
              <span class="audio-player-toast__time">{fmtTime(duration)}</span>
            </div>
          </div>
        </Teleport>
      );
    };
  },
});
