import { defineComponent } from "vue";
import { Folder } from "@lucide/vue";

import type { GameInstallKind } from "@/api";
import { t } from "@/i18n";
import "./PlatformIcon.scss";

/**
 * Game-client platform badge — the distribution channel an install came
 * from (Steam / Wargaming / 360), drawn as a brand-coloured circular disc.
 * Replaces the old realm flags: a client's store channel is not its
 * country, and the realm already shows as a tag next to the client name.
 *
 * Marks: Steam uses the CC0 simple-icons path; Wargaming's W and 360's
 * wordmark are simplified inline stand-ins (no official brand assets are
 * vendored into the repo). Lesta builds carry WG-style branding and both
 * CN kinds are 360-era operators, so those kinds share badges; manual or
 * unknown installs fall back to a neutral disc.
 */

const STEAM_PATH =
  "M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z";

/** Wargaming's W mark as one symmetric polygon (middle peak shortened). */
const WG_W_PATH =
  "M2 4.8 H6.6 L9.1 13.6 L11.15 4.8 H12.85 L14.9 13.6 L17.4 4.8 H22 L17.55 19.2 H14.75 L12 10.9 L9.25 19.2 H6.45 Z";

type PlatformKey = "steam" | "wg" | "cn" | null;

function platformKey(kind: GameInstallKind | null | undefined): PlatformKey {
  switch (kind) {
    case "steam":
      return "steam";
    case "wargaming":
    case "lesta":
      return "wg";
    case "cn360":
    case "cnKongzhong":
      return "cn";
    default:
      return null;
  }
}

const LABELS: Record<Exclude<PlatformKey, null>, string> = {
  steam: "Steam",
  wg: "Wargaming",
  cn: "360",
};

export default defineComponent({
  name: "PlatformIcon",
  props: {
    kind: { type: String as () => GameInstallKind | null | undefined, default: undefined },
    size: { type: Number, default: 38 },
  },
  setup(props) {
    return () => {
      const key = platformKey(props.kind);
      return (
        <span
          class={["platform-icon", key ? `platform-icon--${key}` : null]}
          style={{ width: `${props.size}px`, height: `${props.size}px` }}
          role="img"
          aria-label={key ? LABELS[key] : t("common.game.kind.manual")}
        >
          {key === "steam" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={STEAM_PATH} fill="currentColor" />
            </svg>
          ) : key === "wg" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={WG_W_PATH} fill="currentColor" />
            </svg>
          ) : key === "cn" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <text
                x="12"
                y="12.6"
                text-anchor="middle"
                dominant-baseline="central"
                font-size="9"
                font-weight="700"
                fill="currentColor"
              >
                360
              </text>
            </svg>
          ) : (
            <Folder
              size={Math.max(10, Math.round(props.size * 0.48))}
              class="platform-icon__glyph"
            />
          )}
        </span>
      );
    };
  },
});
