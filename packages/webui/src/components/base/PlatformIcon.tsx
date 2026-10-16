import { defineComponent } from "vue";
import { Folder } from "@lucide/vue";

import type { GameInstallKind } from "@/api";
import { t } from "@/i18n";
import "./PlatformIcon.scss";

/**
 * Game-client platform badge — the distribution channel an install came
 * from (Steam / Wargaming / Lesta / 360), drawn after each channel's
 * official mark. Replaces the old realm flags: a client's store channel
 * is not its country, and the realm already shows as a tag next to the
 * client name.
 *
 * Marks are hand-traced inline SVG measured off each platform's official
 * icon (no brand assets are vendored into the repo): Steam's piston
 * roundel inset on its navy-to-azure disc, the World of Warships anchor
 * shield for Wargaming installs and its cyan hexagon twin for Lesta's
 * Мир кораблей, and true vector 360 digits (the old SVG <text> sagged
 * off-centre and tracked the system font). Manual or unknown installs
 * fall back to a neutral disc.
 */

const STEAM_PATH =
  "M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z";

/** The blocky WoWS anchor shared by the WG shield and the Lesta hexagon. */
const WOWS_ANCHOR_PATH =
  "M8.86 3.75 L15.14 3.75 L15.14 5.44 L13.59 6.75 L10.41 6.75 L8.86 5.44 Z M7.31 7.12 L16.69 7.12 L16.69 9.38 L13.59 10.69 L10.41 10.69 L7.31 9.38 Z M10.41 6.75 L13.59 6.75 L13.59 17.81 L10.41 17.81 Z M5.77 10.59 L8.58 11.81 L8.58 15.94 L5.77 15.94 Z M18.23 10.59 L15.42 11.81 L15.42 15.94 L18.23 15.94 Z M5.77 15.38 L18.23 15.38 L18.23 17.25 L12 19.78 L5.77 17.25 Z";

/** World of Warships plate: white rim + blue field (WG installs). */
const WG_SHIELD_OUTER_PATH =
  "M2.48 0 L21.52 0 L21.52 19.12 L12 23.72 L2.48 19.12 Z";
const WG_SHIELD_INNER_PATH =
  "M3.98 1.5 L20.02 1.5 L20.02 18.38 L12 22.03 L3.98 18.38 Z";

/** Lesta's Мир кораблей plate: the same anchor on a cyan hexagon. */
const LESTA_PLATE_PATH =
  "M6.98 0 L17.02 0 L21.33 3.28 L21.33 17.62 L12 23.91 L2.67 17.62 L2.67 3.28 Z";

/** Vector "360" digits — Roboto Bold outlines (Apache 2.0), extracted
    with opentype.js and centred on the disc so no live font is involved. */
const CN_360_PATH =
  "M6.05 12.43L6.05 11.44L6.73 11.44Q7.21 11.44 7.45 11.20Q7.68 10.95 7.68 10.55Q7.68 10.17 7.45 9.95Q7.22 9.74 6.81 9.74Q6.45 9.74 6.20 9.94Q5.96 10.14 5.96 10.46L4.69 10.46Q4.69 9.96 4.96 9.56Q5.23 9.16 5.71 8.94Q6.20 8.71 6.78 8.71Q7.80 8.71 8.37 9.20Q8.95 9.68 8.95 10.54Q8.95 10.98 8.68 11.35Q8.41 11.71 7.98 11.91Q8.52 12.11 8.78 12.49Q9.05 12.88 9.05 13.41Q9.05 14.26 8.43 14.77Q7.81 15.29 6.78 15.29Q5.82 15.29 5.21 14.78Q4.61 14.28 4.61 13.45L5.88 13.45Q5.88 13.81 6.15 14.03Q6.42 14.26 6.81 14.26Q7.26 14.26 7.52 14.02Q7.78 13.78 7.78 13.39Q7.78 12.43 6.72 12.43L6.05 12.43M13.16 8.73L13.37 8.73L13.37 9.78L13.25 9.78Q12.38 9.79 11.86 10.23Q11.33 10.66 11.23 11.44Q11.74 10.92 12.52 10.92Q13.35 10.92 13.84 11.52Q14.34 12.11 14.34 13.09Q14.34 13.71 14.07 14.22Q13.80 14.72 13.30 15.01Q12.81 15.29 12.18 15.29Q11.17 15.29 10.55 14.58Q9.93 13.88 9.93 12.71L9.93 12.25Q9.93 11.21 10.32 10.41Q10.71 9.61 11.45 9.18Q12.19 8.74 13.16 8.73M12.13 11.94Q11.82 11.94 11.57 12.10Q11.32 12.26 11.20 12.52L11.20 12.91Q11.20 13.55 11.45 13.91Q11.70 14.26 12.16 14.26Q12.56 14.26 12.82 13.94Q13.07 13.62 13.07 13.10Q13.07 12.58 12.82 12.26Q12.56 11.94 12.13 11.94M19.39 11.38L19.39 12.55Q19.39 13.88 18.84 14.58Q18.30 15.29 17.24 15.29Q16.19 15.29 15.64 14.60Q15.08 13.91 15.07 12.62L15.07 11.44Q15.07 10.10 15.63 9.41Q16.18 8.71 17.23 8.71Q18.27 8.71 18.83 9.40Q19.38 10.09 19.39 11.38M18.12 12.78L18.12 11.26Q18.12 10.47 17.91 10.10Q17.69 9.74 17.23 9.74Q16.78 9.74 16.57 10.09Q16.35 10.43 16.34 11.17L16.34 12.72Q16.34 13.50 16.55 13.88Q16.77 14.26 17.24 14.26Q17.70 14.26 17.91 13.90Q18.11 13.53 18.12 12.78";

type PlatformKey = "steam" | "wg" | "lesta" | "cn" | null;

function platformKey(kind: GameInstallKind | null | undefined): PlatformKey {
  switch (kind) {
    case "steam":
      return "steam";
    case "wargaming":
      return "wg";
    case "lesta":
      return "lesta";
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
  lesta: "Lesta",
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
              {/* The simple-icons mark is tangent to its viewBox; left as-is
                  it shaves flat at the svg viewport's top/bottom edges. */
              }
              <g transform="translate(1.2 1.2) scale(0.9)">
                <path d={STEAM_PATH} fill="currentColor" />
              </g>
            </svg>
          ) : key === "wg" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={WG_SHIELD_OUTER_PATH} fill="#fff" />
              <path d={WG_SHIELD_INNER_PATH} fill="#1e94cf" />
              <path d={WOWS_ANCHOR_PATH} fill="#fff" />
            </svg>
          ) : key === "lesta" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={LESTA_PLATE_PATH} fill="#00d7eb" />
              <path d={WOWS_ANCHOR_PATH} fill="#010a19" />
            </svg>
          ) : key === "cn" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={CN_360_PATH} fill="currentColor" />
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
