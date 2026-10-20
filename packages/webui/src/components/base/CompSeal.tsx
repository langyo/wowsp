import { defineComponent, type PropType } from "vue";

import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";
import { stampOverrideUrl } from "@/stores/stampOverrides";
import { COMP_ICON_BODY, COMP_ICON_DETAIL, compIconBody48, type CompIconKind } from "@/utils/compIcons";
import type { StampKind } from "@/utils/winrate";
import "./CompSeal.scss";

let sealSeq = 0;

/** The composition kinds' wording — the same strings RatingStamp's faces
 *  carry (the four-char seals own the water meter; this seal says them in
 *  glyph+figure form on the live panel). */
const SEAL_LABEL: Record<"air" | "sub" | "airVeteran" | "subVeteran", string> = {
  air: "空中小人",
  sub: "水下小人",
  airVeteran: "空中奶龙",
  subVeteran: "水下奶蛙",
};

/** Ink-roughening seeds keyed by CLASS (not tier) — the same RatingStamp
 *  seeds the minor-tier four-char faces carry, so a class's icon seal
 *  presses with its 小人 sibling's ink texture; the veteran tier shares
 *  the glyph and therefore the seed (its stronger verdict speaks through
 *  the wash, not a different grain). */
const SEAL_SEED: Record<CompIconKind, number> = { air: 21, sub: 5 };

/**
 * Square composition SEAL (印章样式的成分图标) — the live panel's 空中小人 /
 * 水下小人 face: the plane / submarine glyph (utils/compIcons, dual-track)
 * pressed in the upper zone of a square seal and the career-share figure
 * ("34%") stamped beneath it, so the tier story (share > 20% minor, > 50%
 * veteran) and the exact composition read in one glance. Deliberately a
 * SIBLING of RatingStamp, not a variant of it: same 100×100 face, same
 * double frame geometry, same ink-roughening filter and −9° press, same
 * cinnabar — the icon reads as one more seal in the family, never as a
 * foreign widget. The veteran tier adds a faint inner wash (印底) — the
 * stronger verdict presses harder.
 *
 *  - `variant="mini"` (default): the tight frame the live roster rows'
 *    34px stamps use, glyph on the 24-grid silhouette (the mini track);
 *    `"full"` keeps the classic wide border + moiré weave for any large
 *    rendering, glyph on the detailed 48-grid track.
 *  - A user-imported custom picture for the kind — falling back to its
 *    minor-tier sibling, so one picture covers both tiers — replaces the
 *    GLYPH inside the frame; the frame and the share figure stay.
 *
 * The seals are a Chinese-community artifact — this renders nothing under
 * any other UI language, and a seal switched off individually (statsPrefs
 * sealDisabled, keyed by the tier's own kind) never renders either. The
 * PR/seals master gates are the hosts' (as with RatingStamp).
 */
export default defineComponent({
  name: "CompSeal",
  props: {
    /** Which class the player mains — the glyph and the tier's kind. */
    cls: { type: String as PropType<CompIconKind>, required: true },
    /** >50% career share — the 奶龙 / 奶蛙 tier (implies the class flag). */
    veteran: { type: Boolean, default: false },
    /** Career share of the class, percent 0–100 (null/absent = figure off). */
    share: { type: Number as PropType<number | null>, default: null },
    /** Rendered edge length in px. */
    size: { type: Number, default: 34 },
    variant: { type: String as PropType<"full" | "mini">, default: "mini" },
  },
  setup(props) {
    const { uiLocale } = useLanguage();
    const uid = `comp-seal-${++sealSeq}`;

    return () => {
      if (!uiLocale.value.startsWith("zh")) return null;
      const kind: StampKind =
        props.cls === "air"
          ? props.veteran
            ? "airVeteran"
            : "air"
          : props.veteran
            ? "subVeteran"
            : "sub";
      if (statsPrefsState.value.sealDisabled[kind]) return null;
      const mini = props.variant === "mini";
      const pct = props.share != null ? Math.round(props.share) : null;
      const label = SEAL_LABEL[kind];
      const id = (part: string) => `${uid}-${part}`;
      const url = (part: string) => `url(#${id(part)})`;
      const custom = stampOverrideUrl(kind) ?? stampOverrideUrl(props.cls);
      return (
        <svg
          class="comp-seal"
          width={props.size}
          height={props.size}
          viewBox="0 0 100 100"
          role="img"
          aria-label={label}
        >
          <title>
            {label}
            {pct != null ? ` ${pct}%` : ""}
          </title>
          <defs>
            {/* The same ink-roughening displacement RatingStamp's faces
                press (scale per variant), so the family's press matches. */}
            <filter id={id("ink")} x="-8%" y="-8%" width="116%" height="116%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.55"
                numOctaves="2"
                seed={SEAL_SEED[props.cls]}
                result="grain"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="grain"
                scale={mini ? 1.2 : 2.6}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
            {!mini && (
              <>
                <pattern id={id("weave-a")} width="5" height="5" patternUnits="userSpaceOnUse">
                  <path d="M2.5 0 V5" stroke="currentColor" stroke-width="0.7" />
                </pattern>
                <pattern
                  id={id("weave-b")}
                  width="5"
                  height="5"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(2.4)"
                >
                  <path d="M2.5 0 V5" stroke="currentColor" stroke-width="0.7" />
                </pattern>
              </>
            )}
          </defs>
          <g class="comp-seal__ink" filter={url("ink")}>
            {/* Frame geometry per variant — RatingStamp's own, so the two
                seals' faces are interchangeable in a row. */}
            {!mini && (
              <g class="comp-seal__moire">
                <rect x="12.5" y="12.5" width="75" height="75" fill={url("weave-a")} />
                <rect x="12.5" y="12.5" width="75" height="75" fill={url("weave-b")} />
              </g>
            )}
            <rect
              class="comp-seal__frame"
              x={mini ? 3.5 : 5}
              y={mini ? 3.5 : 5}
              width={mini ? 93 : 90}
              height={mini ? 93 : 90}
              rx={mini ? 6 : 7}
              stroke-width={mini ? 4 : 6}
            />
            <rect
              class="comp-seal__frame"
              x={mini ? 10.5 : 12.5}
              y={mini ? 10.5 : 12.5}
              width={mini ? 79 : 75}
              height={mini ? 79 : 75}
              rx={mini ? 2.5 : 3}
              stroke-width={mini ? 1.5 : 2}
            />
            {/* The veteran tier's 印底 — a faint inner wash pressing the
                stronger verdict harder than the minor tier's bare face. */}
            {props.veteran && (
              <rect
                x={mini ? 10.5 : 12.5}
                y={mini ? 10.5 : 12.5}
                width={mini ? 79 : 75}
                height={mini ? 79 : 75}
                rx={mini ? 2.5 : 3}
                fill="currentColor"
                opacity={mini ? 0.1 : 0.12}
              />
            )}
            {/* The glyph zone: the class silhouette — the 24-grid mini
                track scaled up, or the 48-grid body + detail layer the
                full variant presses — or the user's custom picture
                centered in its place. */}
            {custom != null ? (
              <image
                href={custom}
                x={mini ? 25 : 26}
                y={mini ? 12.5 : 12}
                width={mini ? 50 : 48}
                height={mini ? 50 : 48}
                preserveAspectRatio="xMidYMid meet"
              />
            ) : mini ? (
              <g transform="translate(27 14) scale(1.917)">
                <path d={COMP_ICON_BODY[props.cls]} fill="currentColor" />
              </g>
            ) : (
              <g transform="translate(26 13)">
                <path d={compIconBody48(props.cls)} fill="currentColor" />
                {/* The detail layer (prop arc / periscope / portholes …) —
                    static trusted markup from utils/compIcons. */}
                <g class="comp-seal__detail" innerHTML={COMP_ICON_DETAIL[props.cls]} />
              </g>
            )}
            {/* The career-share figure — the seal's second "character row",
                stamped under the glyph the way the four-char faces stack
                their two rows. */}
            {pct != null && (
              <text
                class="comp-seal__pct"
                x="50"
                y={mini ? 82 : 85}
                text-anchor="middle"
                font-size={mini ? 24 : 23}
                font-weight={700}
              >
                {pct}%
              </text>
            )}
          </g>
        </svg>
      );
    };
  },
});
