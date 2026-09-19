import { computed, defineComponent, watchEffect } from "vue";

import { getThemeTokens, useTheme } from "@celestia-island/hikari";

import AuthorMark from "@/components/base/AuthorMark";
import { useWallpaper } from "@/theme/useWallpaper";
import { t } from "@/i18n";

/**
 * Applies the active wallpaper to <body> via CSS custom properties, and —
 * when the active wallpaper carries an art credit — renders the desktop
 * corner author mark (the same shared AuthorMark component the settings
 * attributions list uses).
 *
 * Writes:
 *   --wallpaper-solid-color: #000 / #fff / transparent
 *   --wallpaper-image: url(...) or none
 *   --wallpaper-overlay-opacity: 0..1
 *
 * These are consumed by theme.scss's body + body::before rules.
 */
export default defineComponent({
  name: "WallpaperRenderer",
  setup() {
    const wp = useWallpaper();
    const theme = useTheme();

    const style = computed(() => {
      const tokens = getThemeTokens(theme.currentTheme.value, theme.effectiveMode.value);

      const s: Record<string, string> = {};

      if (wp.solidColor.value) {
        s["--wallpaper-solid-color"] = wp.solidColor.value === "white" ? "#f8fafc" : "#0b1220";
        s["--wallpaper-image"] = "none";
      } else if (wp.mediaUrl.value) {
        s["--wallpaper-image"] = `url(${wp.mediaUrl.value})`;
        s["--wallpaper-solid-color"] = tokens
          ? `rgb(${tokens.background.r} ${tokens.background.g} ${tokens.background.b})`
          : "transparent";
      } else {
        // Fallback: theme background.
        s["--wallpaper-solid-color"] = tokens
          ? `rgb(${tokens.background.r} ${tokens.background.g} ${tokens.background.b})`
          : "transparent";
        s["--wallpaper-image"] = "none";
      }
      s["--wallpaper-overlay-opacity"] = String(wp.overlayOpacity.value);
      return s;
    });

    watchEffect(() => {
      const body = document.body;
      for (const [k, v] of Object.entries(style.value)) {
        body.style.setProperty(k, v);
      }
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
