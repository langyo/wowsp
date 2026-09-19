import { defineComponent, type PropType } from "vue";

import { useLanguage } from "@/i18n/useLanguage";
import type { StampKind } from "@/utils/winrate";
import stampAir from "../../res/stamps/stamp-air.png";
import stampApe from "../../res/stamps/stamp-ape.png";
import stampMiracle from "../../res/stamps/stamp-miracle.png";
import stampSub from "../../res/stamps/stamp-sub.png";
import "./RatingStamp.scss";

let stampSeq = 0;

/** Inked career-verdict seal: a procedural SVG frame (double border + moiré
 *  weave + ink-rough displacement filter) around pre-rendered glyph bitmaps.
 *
 *  The glyphs are baked to PNGs by `scripts/gen_stamp_bitmaps.py` (calligraphy
 *  fonts: 神 in 毛体, the rest in 鲁迅行书; the four-char composition tags are
 *  laid out as a 2x2 seal face — 空中 over 小人). The fonts themselves are
 *  commercial / unclear-
 *  license and are NOT bundled — bitmaps only, so the seals look identical
 *  everywhere. Displacement seeds are fixed per kind → deterministic ink.
 *   - "miracle" (神了): PR ≥ 2100 over 500+ battles
 *   - "ape" (海猴): PR < 750
 *   - "air" (空中小人) / "sub" (水下小人): composition tags for CV / submarine
 *     mains (career share > 20% over 200+ battles)
 *
 * The seals are a Chinese-community artifact — they render nothing under any
 * other UI language. */
const STAMP_GLYPHS: Record<StampKind, string> = {
  miracle: stampMiracle,
  ape: stampApe,
  air: stampAir,
  sub: stampSub,
};
const STAMP_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "海猴",
  air: "空中小人",
  sub: "水下小人",
};
const STAMP_SEED: Record<StampKind, number> = { miracle: 7, ape: 13, air: 21, sub: 5 };

export default defineComponent({
  name: "RatingStamp",
  props: {
    kind: { type: String as PropType<StampKind>, required: true },
    /** Rendered edge length in px. */
    size: { type: Number, default: 64 },
    /** "mini" drops the moiré weave for tiny sizes (live roster rows). */
    variant: { type: String as PropType<"full" | "mini">, default: "full" },
  },
  setup(props) {
    const { uiLocale } = useLanguage();
    const uid = `stamp-${++stampSeq}`;

    return () => {
      if (!uiLocale.value.startsWith("zh")) return null;
      const id = (part: string) => `${uid}-${part}`;
      const url = (part: string) => `url(#${id(part)})`;
      const mini = props.variant === "mini";
      return (
        <svg
          class={["rating-stamp", `rating-stamp--${props.kind}`]}
          width={props.size}
          height={props.size}
          viewBox="0 0 100 100"
          role="img"
          aria-label={STAMP_TEXT[props.kind]}
        >
          <defs>
            {/* Two line weaves a hair apart in angle — their interference
                leaves the faint moiré of a cheap rubber stamp. */}
            <pattern id={id("weave-a")} width="5" height="5" patternUnits="userSpaceOnUse">
              <path d="M2.5 0 V5" stroke="currentColor" stroke-width="0.7" />
            </pattern>
            <pattern id={id("weave-b")} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(2.4)">
              <path d="M2.5 0 V5" stroke="currentColor" stroke-width="0.7" />
            </pattern>
            <filter id={id("ink")} x="-8%" y="-8%" width="116%" height="116%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.55"
                numOctaves="2"
                seed={STAMP_SEED[props.kind]}
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
          </defs>
          <g class="rating-stamp__ink" filter={url("ink")}>
            {!mini && (
              <g class="rating-stamp__moire">
                <rect x="14" y="14" width="71" height="71" fill={url("weave-a")} />
                <rect x="14" y="14" width="71" height="71" fill={url("weave-b")} />
              </g>
            )}
            <rect class="rating-stamp__frame" x="5" y="5" width="90" height="90" rx="7" stroke-width="6" />
            <rect class="rating-stamp__frame" x="14.5" y="14.5" width="71" height="71" rx="3" stroke-width="2" />
            {/* Glyph bitmap (pre-centered cinnabar: single-glyph verdicts,
                2x2 composition tags), inset to sit well inside the inner
                frame — full-bleed glyphs read too heavy at seal sizes. */}
            <image href={STAMP_GLYPHS[props.kind]} x="17" y="17" width="66" height="66" />
          </g>
        </svg>
      );
    };
  },
});
