/**
 * Catalog detail preview clip for an entry that publishes a standard
 * `preview_video` (thread front-matter): a poster tile with an explicit
 * play button. Nothing streams until the button is pressed — the player
 * element only mounts afterwards — and its poster is the entry's preview
 * image through the media proxy. The small format line under the media
 * states the standard the clip follows. Entries without a clip never mount
 * this component (their screenshot preview stays the DetailPane's own
 * HkImagePreview path).
 */
import { defineComponent, ref } from "vue";
import { Clapperboard, PlayCircle } from "@lucide/vue";
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
            <HkMediaPlayer
              src={props.videoSrc}
              type="video"
              poster={props.posterSrc || undefined}
            />
          ) : (
            <div class="catalog-preview__gate">
              {props.posterSrc ? (
                <img
                  class="catalog-preview__poster"
                  src={props.posterSrc}
                  alt={props.alt}
                  loading="lazy"
                />
              ) : (
                <div class="catalog-preview__poster catalog-preview__poster--empty">
                  <Clapperboard size={22} />
                  <span>{t("resources.previewVideo.standard")}</span>
                </div>
              )}
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
