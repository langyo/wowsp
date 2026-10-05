/**
 * Installed-unit asset previews: texture/image units render a lazy
 * thumbnail grid (each tile pulls a decoded, downscaled PNG data URL from
 * the backend on first visibility), voice units list their audio files
 * one-per-row; a click hands the track to the global audioPlayer store,
 * whose AudioPlayerToast card (play/pause, seek, stop) controls playback.
 * The game's Wwise `.wem` files play through the on-read transcode (the
 * first click converts — decode-validated on the Rust side — then plays).
 */
import { defineComponent, ref, watch } from "vue";
import { ImageIcon, Music, PlayCircle } from "@lucide/vue";

import { api, type AssetFileInfo } from "@/api";
import { t } from "@/i18n";
import { useAudioPlayerStore } from "@/stores/audioPlayer";

export default defineComponent({
  name: "AssetPreview",
  props: {
    gameRoot: { type: String, required: true },
    /** Installed unit primary path (res_mods-relative). */
    relPath: { type: String, required: true },
    /** `image` grid or `audio` list. */
    mode: { type: String as () => "image" | "audio", required: true },
  },
  setup(props) {
    const files = ref<AssetFileInfo[]>([]);
    const loading = ref(false);
    // Plain objects (not Map/Set): property writes stay reactive, so a
    // fetched thumbnail re-renders its tile.
    const thumbs = ref<Record<string, string>>({});
    const failed = ref<Record<string, boolean>>({});
    const player = useAudioPlayerStore();

    async function load() {
      loading.value = true;
      try {
        files.value = await api.modHubListAssets(props.gameRoot, props.relPath);
      } catch {
        files.value = [];
      } finally {
        loading.value = false;
      }
    }
    watch(() => [props.gameRoot, props.relPath], load, { immediate: true });

    // Thumbnails pull eagerly (capped): texture tiles are small decoded
    // PNGs, and an eager batch keeps the grid alive where an
    // intersection-driven lazy loader fights the detail pane's scroll
    // container.
    const PREVIEW_CAP = 24;
    watch(files, (list) => {
      let queued = 0;
      for (const f of list) {
        if (f.kind !== "image" || queued >= PREVIEW_CAP) continue;
        queued += 1;
        void ensureThumb(f.rel);
      }
    });

    async function ensureThumb(rel: string) {
      if (thumbs.value[rel] || failed.value[rel]) return;
      try {
        const payload = await api.modHubReadAsset(props.gameRoot, rel);
        thumbs.value[rel] = payload.dataUrl;
      } catch {
        failed.value[rel] = true;
      }
    }

    function kbFormat(n: number): string {
      return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
    }

    // A row click hands the track to the global player: same track
    // toggles pause/resume, a new one loads (for .wem that is the
    // transcode round-trip) and starts. Playback itself is controlled
    // from the AudioPlayerToast card.
    async function toggle(file: AssetFileInfo) {
      if (!file.playable) return;
      const name = file.rel.split("/").pop() || file.rel;
      await player.play(file.rel, name, async () => {
        const payload = await api.modHubReadAsset(props.gameRoot, file.rel);
        return payload.dataUrl;
      });
    }

    return () => {
      if (loading.value) {
        return <div class="asset-preview__note">{t("resources.loadingAssets")}</div>;
      }
      const usable = files.value.filter((f) => f.kind === props.mode);
      if (usable.length === 0) {
        return <div class="asset-preview__note">{t("resources.noAssets")}</div>;
      }
      if (props.mode === "image") {
        return (
          <div class="asset-preview__grid">
            {usable.map((f) => (
              <figure class="asset-preview__tile" key={f.rel} title={f.rel}>
                {thumbs.value[f.rel] ? (
                  <img src={thumbs.value[f.rel]} alt={f.rel} />
                ) : failed.value[f.rel] ? (
                  <span class="asset-preview__tile-fallback">
                    <ImageIcon size={16} />
                    <em>{f.ext}</em>
                  </span>
                ) : (
                  <span class="asset-preview__tile-fallback asset-preview__tile-fallback--loading" />
                )}
                <figcaption>{f.rel.split("/").pop()}</figcaption>
              </figure>
            ))}
          </div>
        );
      }
      return (
        <ul class="asset-preview__audio">
          {usable.map((f) => (
            <li key={f.rel} class="asset-preview__audio-row">
              <button
                type="button"
                class="asset-preview__audio-btn"
                disabled={!f.playable}
                data-hint={t("resources.audioPlay")}
                onClick={() => void toggle(f)}
              >
                {player.active && player.rel === f.rel ? (
                  <PlayCircle size={14} />
                ) : (
                  <Music size={14} />
                )}
                <span class="asset-preview__audio-name">
                  {f.rel.split("/").pop()}
                </span>
                <span class="asset-preview__audio-size">{kbFormat(f.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      );
    };
  },
});