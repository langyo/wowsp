/**
 * Installed-unit asset previews. The material section (mode "texture") is
 * ONE preview area for a pack's whole visual payload, from a single asset
 * listing: texture thumbnails render as a lazy grid (each tile pulls a
 * decoded, downscaled PNG data URL from the backend on first visibility)
 * and `.geometry` files (custom ship/gun/aircraft meshes) render as model
 * rows beneath — a click asks the backend to expand the click into its
 * hull-family GLB parts and hands them to the holo ModelStage above the
 * rows. Voice units (mode "audio") list their audio files one-per-row
 * with a localized scenario title above the raw file name (from the
 * pack's mod.xml event map + the voice-scenes registry); a click hands
 * the track to the global audioPlayer store, whose AudioPlayerToast card
 * (play/pause, seek, stop) controls playback even after the pane is left.
 * The game's Wwise `.wem` files play through the on-read decode (the
 * first click converts to WAV in Rust, then plays). Modes "image" and
 * "model" are the single-kind fallbacks for panes that only ever show
 * one of the two material kinds.
 */
import { defineComponent, ref, watch } from "vue";
import { Box, ImageIcon, Music, PlayCircle } from "@lucide/vue";
import { useToast } from "@celestia-island/hikari";

import { api, type AssetFileInfo, type ModelPreviewPart } from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useAudioPlayerStore } from "@/stores/audioPlayer";
import ModelStage from "./ModelStage";
import { compareByScene, humanizeEvent, humanizeState, sceneLabel } from "./voiceScenes";

export default defineComponent({
  name: "AssetPreview",
  props: {
    gameRoot: { type: String, required: true },
    /** Installed unit primary path (res_mods-relative). */
    relPath: { type: String, required: true },
    /** `texture` grid + model stage (one listing), `image` grid, `audio`
     *  list, or `model` rows + 3D stage. */
    mode: {
      type: String as () => "texture" | "image" | "audio" | "model",
      required: true,
    },
    /** Render nothing when the unit has no files of this mode — sections
     *  that are merely possible (models under a script unit) stay
     *  invisible instead of showing an empty note. */
    silentEmpty: { type: Boolean, default: false },
  },
  setup(props) {
    const files = ref<AssetFileInfo[]>([]);
    const loading = ref(false);
    // Plain objects (not Map/Set): property writes stay reactive, so a
    // fetched thumbnail re-renders its tile.
    const thumbs = ref<Record<string, string>>({});
    const failed = ref<Record<string, boolean>>({});
    const player = useAudioPlayerStore();
    const { uiLocale } = useLanguage();
    const toast = useToast();
    // Model mode: the family parts of the clicked .geometry row. The
    // session token kills in-flight expansions when the unit switches.
    const modelParts = ref<ModelPreviewPart[] | null>(null);
    const modelRel = ref("");
    const modelLoading = ref(false);
    let modelSession = 0;

    async function load() {
      loading.value = true;
      // Kill any in-flight model expansion for the old unit — and drop its
      // busy flag, or a load settling after a unit switch would leave the
      // rows disabled forever (the pane patches in place across switches).
      modelSession += 1;
      modelLoading.value = false;
      modelParts.value = null;
      modelRel.value = "";
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
    // decode round-trip) and starts. The card controls the rest.
    async function toggle(file: AssetFileInfo) {
      if (!file.playable) return;
      const name = file.rel.split("/").pop() || file.rel;
      await player.play(file.rel, name, async () => {
        const payload = await api.modHubReadAsset(props.gameRoot, file.rel);
        return payload.dataUrl;
      });
    }

    // A model row click asks the backend to expand the clicked `.geometry`
    // into its family (hull base + sections, or a standalone mesh) and
    // hands the cached GLB parts to the stage; the clicked row ignores
    // re-clicks. Stale loads (superseded by a unit switch or a newer
    // click) die on the session token.
    async function toggleModel(file: AssetFileInfo) {
      if (modelLoading.value) return;
      if (modelRel.value === file.rel) return;
      const mySession = ++modelSession;
      modelLoading.value = true;
      try {
        const parts = await api.modHubReadModel(props.gameRoot, file.rel);
        if (mySession === modelSession) {
          modelRel.value = file.rel;
          modelParts.value = parts;
        }
      } catch (e) {
        if (mySession === modelSession) {
          const detail = e instanceof Error ? e.message : String(e);
          toast.error(`${t("resources.modelLoadFailed")}: ${detail}`);
        }
      } finally {
        if (mySession === modelSession) modelLoading.value = false;
      }
    }

    // Lazy thumbnail grid — shared by the texture section and the plain
    // image mode.
    function renderGrid(list: AssetFileInfo[]) {
      return (
        <div class="asset-preview__grid">
          {list.map((f) => (
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

    // Compact mesh rows under the stage: hull sections expand to the whole
    // ship (whichever row was clicked), other meshes (guns, aircraft,
    // directors) preview standalone — shared by the texture section and the
    // plain model mode.
    function renderModelBlock(list: AssetFileInfo[]) {
      const rows = [...list].sort((a, b) => a.rel.localeCompare(b.rel));
      return (
        <div class="asset-preview__model">
          {modelParts.value ? <ModelStage parts={modelParts.value} /> : null}
          <ul class="asset-preview__model-rows">
            {rows.map((f) => (
              <li key={f.rel} class="asset-preview__model-row">
                <button
                  type="button"
                  class={{
                    "asset-preview__model-btn": true,
                    "asset-preview__model-btn--active": modelRel.value === f.rel,
                  }}
                  disabled={modelLoading.value}
                  data-hint={t("resources.modelPlay")}
                  onClick={() => void toggleModel(f)}
                >
                  <Box size={14} />
                  <span class="asset-preview__model-name">{f.rel.split("/").pop()}</span>
                  <span class="asset-preview__model-size">{kbFormat(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    return () => {
      if (loading.value) {
        if (props.silentEmpty) return null;
        return <div class="asset-preview__note">{t("resources.loadingAssets")}</div>;
      }
      const kinds = props.mode === "texture" ? ["image", "model"] : [props.mode];
      const usable = files.value.filter((f) => kinds.includes(f.kind));
      if (usable.length === 0) {
        if (props.silentEmpty) return null;
        return <div class="asset-preview__note">{t("resources.noAssets")}</div>;
      }
      // The material section: thumbnails and meshes are one preview area
      // for one pack — a recolor's paints and shapes belong together.
      if (props.mode === "texture") {
        const imgs = usable.filter((f) => f.kind === "image");
        const models = usable.filter((f) => f.kind === "model");
        return (
          <div class="asset-preview__texture">
            {imgs.length > 0 && renderGrid(imgs)}
            {models.length > 0 && renderModelBlock(models)}
          </div>
        );
      }
      if (props.mode === "image") return renderGrid(usable);
      if (props.mode === "model") return renderModelBlock(usable);
      // Scene-titled rows: mod.xml-mapped lines carry a localized
      // scenario title above the raw file name (the hash name alone
      // tells nobody what the line is FOR); unmapped files keep the old
      // single-line shape. Scene rows group by event, orphans trail.
      const audioRows = [...usable].sort(compareByScene);
      return (
        <ul class="asset-preview__audio">
          {audioRows.map((f) => {
            const fileName = f.rel.split("/").pop();
            const title = f.sceneEvent
              ? (sceneLabel(f.sceneEvent, uiLocale.value) ?? humanizeEvent(f.sceneEvent))
              : fileName;
            return (
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
                  <span class="asset-preview__audio-body">
                    <span class="asset-preview__audio-title">
                      {title}
                      {f.sceneState ? (
                        <em class="asset-preview__audio-state">
                          {humanizeState(f.sceneEvent!, f.sceneState)}
                        </em>
                      ) : null}
                      {f.sceneIndex && f.sceneIndex > 1 ? (
                        <em class="asset-preview__audio-idx">#{f.sceneIndex}</em>
                      ) : null}
                    </span>
                    {f.sceneEvent ? (
                      <span class="asset-preview__audio-name">{fileName}</span>
                    ) : null}
                  </span>
                  <span class="asset-preview__audio-size">{kbFormat(f.size)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      );
    };
  },
});