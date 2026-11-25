/**
 * Catalog detail preview clip for an entry that publishes a standard
 * `preview_video` (thread front-matter): a play-gated clip on the SAME
 * visual vocabulary as AssetPreview's installed/layer players (the
 * asset-preview video card wraps hikari's player once started). Nothing
 * streams until the play button is pressed — the player element only
 * mounts afterwards — and its poster is the entry's preview image through
 * the media proxy. The gate surface itself carries ONLY the play button:
 * an entry without a poster keeps the bare dark gate (the standard line
 * under the media already names the format), so no centered caption can
 * collide with the centered button. The small format line under the media
 * states the standard the clip follows. Entries without a clip never mount
 * this component (their screenshot preview stays the DetailPane's own
 * HkImagePreview path).
 */
import { defineComponent, ref } from "vue";
import { PlayCircle } from "@lucide/vue";
import { HkButton, HkMediaPlayer } from "@celestia-island/hikari";

import { t } from "@/i18n";

export default defineComponent({
  name: "CatalogPreviewMedia",
  props: {
    /** Standard preview clip (empty when the entry has none). */
    videoSrc: { type: String, default: "" },
    /** Poster for the clip / still shown before play (media-proxied URL). */
    posterSrc: { type: String, default: "" },
    alt: { type: String, default: "" },
  },
  setup(props) {
    const started = ref(false);
    return () => {
      // The pane only mounts this component for entries that declare a
      // preview clip; no clip means no media here (the screenshot preview
      // keeps its own HkImagePreview path in DetailPane).
      if (!props.videoSrc) return null;
      return (
        <div class="catalog-preview">
          {started.value ? (
            // The started player rides the installed/layer panes' video
            // card classes, so the catalog clip sizes and captions like
            // every other inline player (the shared .asset-preview__video
            // rule caps the player surface).
            <div class="asset-preview__videos">
              <figure class="asset-preview__video">
                <HkMediaPlayer
                  src={props.videoSrc}
                  type="video"
                  poster={props.posterSrc || undefined}
                />
              </figure>
            </div>
          ) : (
            <div class="catalog-preview__gate">
              {props.posterSrc && (
                <img
                  class="catalog-preview__poster"
                  src={props.posterSrc}
                  alt={props.alt}
                  loading="lazy"
                />
              )}
              {/* The gate carries ONLY the play button — a posterless entry
                  keeps the bare dark surface, and the standard line below
                  the gate already names the format (the old centered
                  Clapperboard caption collided with the centered button). */}
              <HkButton
                size="sm"
                variant="primary"
                class="catalog-preview__play"
                onClick={() => (started.value = true)}
              >
                <PlayCircle size={13} />
                {t("resources.previewVideo.play")}
              </HkButton>
            </div>
          )}
          <span class="catalog-preview__standard">
            {t("resources.previewVideo.standard")}
          </span>
        </div>
      );
    };
  },
});
