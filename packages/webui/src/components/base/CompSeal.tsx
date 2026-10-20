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
 *  glyph form on the live panel). */
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
 *  the formation and the wash, not a different grain). */
const SEAL_SEED: Record<CompIconKind, number> = { air: 21, sub: 5 };

/**
 * Square composition SEAL (印章样式的成分图标) — the live panel's 空中小人 /
 * 水下小人 face: the plane / submarine glyph (utils/compIcons, dual-track)
 * pressed alone in the square face, NO figure — the tier speaks through the
 * GLYPH COUNT alone (a share over 20% presses one glyph; over 50% presses a
 * THREE-GLYPH TRIANGLE FORMATION, one big above two small — a flight for
 * the CV main, a wolfpack for the SS main). Deliberately a SIBLING of
 * RatingStamp, not a variant of it: same 100×100 face, same double frame
 * geometry, same ink-roughening filter and −9° press, same cinnabar — the
 * icon reads as one more seal in the family, never as a foreign widget.
 * The veteran tier adds a faint inner wash (印底) — the stronger verdict
 * presses harder.
 *
 *  - `variant="mini"` (default): the tight frame the live roster rows'
 *    34px stamps use, plain silhouettes on the 24-grid track; `"full"`
 *    keeps the classic wide border + moiré weave for any large rendering,
 *    the lead glyph on the detailed 48-grid track.
 *  - A user-imported custom picture for the kind — falling back to its
 *    minor-tier sibling, so one picture covers both tiers — replaces the
 *    whole glyph zone; the wash still carries the tier.
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
    /** >50% career share — the 奶龙 / 奶蛙 tier (implies the class flag):
     *  the triangle formation plus the inner wash. */
    veteran: { type: Boolean, default: false },
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
      const label = SEAL_LABEL[kind];
      const id = (part: string) => `${uid}-${part}`;
      const url = (part: string) => `url(#${id(part)})`;
      const custom = stampOverrideUrl(kind) ?? stampOverrideUrl(props.cls);
      const body = COMP_ICON_BODY[props.cls];
      /** The glyph zone — one centered glyph over 20%, the big-over-two
       *  triangle formation over 50%. Full-variant coordinates press the
       *  detailed 48-grid track for the lead glyph (scaled whole, so its
       *  detail layer rides along); the flanks stay plain silhouettes. */
      const glyphZone = () => {
        if (custom != null) {
          return (
            <image
              href={custom}
              x={mini ? 14 : 16}
              y={mini ? 12 : 14}
              width={mini ? 72 : 68}
              height={mini ? 76 : 72}
              preserveAspectRatio="xMidYMid meet"
            />
          );
        }
        if (mini) {
          return props.veteran ? (
            <>
              <g transform="translate(28.4 13.5) scale(1.8)">
                <path d={body} fill="currentColor" />
              </g>
              <g transform="translate(20.5 62.5) scale(1.02)">
                <path d={body} fill="currentColor" />
              </g>
              <g transform="translate(54.5 62.5) scale(1.02)">
                <path d={body} fill="currentColor" />
              </g>
            </>
          ) : (
            <g transform="translate(21.8 21.8) scale(2.35)">
              <path d={body} fill="currentColor" />
            </g>
          );
        }
        return props.veteran ? (
          <>
            <g transform="translate(29.6 15) scale(0.85)">
              <path d={compIconBody48(props.cls)} fill="currentColor" />
              {/* The detail layer (prop arc / periscope / portholes …) —
                  static trusted markup from utils/compIcons. */}
              <g class="comp-seal__detail" innerHTML={COMP_ICON_DETAIL[props.cls]} />
            </g>
            <g transform="translate(17.6 59.5) scale(1.1)">
              <path d={body} fill="currentColor" />
            </g>
            <g transform="translate(56 59.5) scale(1.1)">
              <path d={body} fill="currentColor" />
            </g>
          </>
        ) : (
          <g transform="translate(26 26)">
            <path d={compIconBody48(props.cls)} fill="currentColor" />
            <g class="comp-seal__detail" innerHTML={COMP_ICON_DETAIL[props.cls]} />
          </g>
        );
      };
      return (
        <svg
          class="comp-seal"
          width={props.size}
          height={props.size}
          viewBox="0 0 100 100"
          role="img"
          aria-label={label}
        >
          <title>{label}</title>
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
            {glyphZone()}
          </g>
        </svg>
      );
    };
  },
});
