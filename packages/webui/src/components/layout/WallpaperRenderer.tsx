import { defineComponent, onBeforeUnmount, watchEffect } from "vue";

import { getThemeTokens, useTheme } from "@celestia-island/hikari";

import AuthorMark from "@/components/base/AuthorMark";
import { useWallpaper } from "@/theme/useWallpaper";
import { t } from "@/i18n";

/**
 * Paints the active wallpaper, shittim-chest's way: a dedicated fixed media
 * element PREPENDED to <body> (z-index -1, below every app surface) instead
 * of a body background-image — a body background paints at the canvas level,
 * so any opaque surface anywhere in the chrome would hide it, which is
 * exactly how the first cut of this feature ended up invisible. The
 * readability scrim is body::before at z-index 0: above the wallpaper,
 * below #app (z-index 1, see theme.scss) — so the dim only ever applies to
 * the wallpaper itself, and translucent chrome (sidebar, cards, modals)
 * samples the scrim-adjusted image. Solid wallpapers skip the layer
 * entirely and fall back to body's background-color.
 *
 * Writes (consumed by theme.scss):
 *   html[data-wallpaper-art]     scrim gate, only true for image wallpapers
 *   --wallpaper-solid-color      body background color (solid path / backdrop
 *                                behind the image before it decodes)
 *   --wallpaper-overlay-opacity  scrim strength, 0..1 (user preference)
 *
 * When the active wallpaper carries an art credit, the desktop corner author
 * mark renders (the same shared AuthorMark component the settings
 * attributions list uses).
 */

const WALLPAPER_LAYER_ID = "wowsp-wallpaper-layer";

function ensureLayer(): HTMLImageElement {
  let el = document.getElementById(WALLPAPER_LAYER_ID) as HTMLImageElement | null;
  if (!el) {
    el = document.createElement("img");
    el.id = WALLPAPER_LAYER_ID;
    el.className = "wallpaper-layer";
    el.alt = "";
    el.draggable = false;
    document.body.prepend(el);
  }
  return el;
}

function removeLayer() {
  document.getElementById(WALLPAPER_LAYER_ID)?.remove();
}

export default defineComponent({
  name: "WallpaperRenderer",
  setup() {
    const wp = useWallpaper();
    const theme = useTheme();

    watchEffect(() => {
      const html = document.documentElement;
      const body = document.body;
      const tokens = getThemeTokens(theme.currentTheme.value, theme.effectiveMode.value);
      const backdrop = tokens
        ? `rgb(${tokens.background.r} ${tokens.background.g} ${tokens.background.b})`
        : "transparent";
      const url = wp.mediaUrl.value;

      if (wp.isSolid.value || !url) {
        // Solid (or nothing to paint): no layer, no scrim — body's own
        // background color is the whole show.
        html.removeAttribute("data-wallpaper-art");
        removeLayer();
        body.style.setProperty("--wallpaper-solid-color", wp.solidColor.value === "white" ? "#f8fafc" : backdrop);
        body.style.setProperty("--wallpaper-overlay-opacity", "0");
        return;
      }

      html.dataset.wallpaperArt = "true";
      ensureLayer().src = url;
      // Theme-colored backdrop behind the image (visible while it decodes,
      // and what the scrim tints toward).
      body.style.setProperty("--wallpaper-solid-color", backdrop);
      body.style.setProperty("--wallpaper-overlay-opacity", String(wp.overlayOpacity.value));
    });

    onBeforeUnmount(() => {
      // The renderer is app-singleton and never unmounts in practice, but
      // leave no orphan layer if a future refactor does.
      document.documentElement.removeAttribute("data-wallpaper-art");
      removeLayer();
    });

    return () => {
      const author = wp.activeAuthor.value;
      if (!author || !wp.mediaUrl.value) return null;
      return (
        <AuthorMark
          compact
          name={author.name}
          url={author.url}
          prefix={t("about.attribution.wallpaperMark")}
        />
      );
    };
  },
});
