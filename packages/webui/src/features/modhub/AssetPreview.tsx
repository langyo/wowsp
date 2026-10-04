/**
 * Installed-unit asset previews: texture/image units render a lazy
 * thumbnail grid (each tile pulls a decoded, downscaled PNG data URL from
 * the backend on first visibility), voice units list their audio files
 * one-per-row with inline playback (native formats only — the game's
 * Wwise `.wem` files are listed but flagged unplayable).
 */
import { defineComponent, ref, watch } from "vue";
import { ImageIcon, Music, PlayCircle } from "@lucide/vue";

import { api, type AssetFileInfo } from "@/api";
import { t } from "@/i18n";

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
    const playing = ref("");
    const audioEl = ref<HTMLAudioElement | null>(null);

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

    async function toggle(file: AssetFileInfo) {
      if (!file.playable) return;
      if (playing.value === file.rel) {
        audioEl.value?.pause();
        playing.value = "";
        return;
      }
      try {
        const payload = await api.modHubReadAsset(props.gameRoot, file.rel);
        const el = audioEl.value ?? new Audio();
        el.src = payload.dataUrl;
        el.onended = () => (playing.value = "");
        void el.play();
        audioEl.value = el;
        playing.value = file.rel;
      } catch {
        playing.value = "";
      }
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
                data-hint={
                  f.playable
                    ? t("resources.audioPlay")
                    : t("resources.audioWem")
                }
                onClick={() => void toggle(f)}
              >
                {playing.value === f.rel ? (
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