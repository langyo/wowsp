import { defineComponent, type PropType } from "vue";

import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";
import { stampOverrideUrl } from "@/stores/stampOverrides";
import type { StampKind } from "@/utils/winrate";
import stampAir from "../../res/stamps/stamp-air.png";
import stampApe from "../../res/stamps/stamp-ape.png";
import stampMaggot from "../../res/stamps/stamp-maggot.png";
import stampMiracle from "../../res/stamps/stamp-miracle.png";
import stampRat from "../../res/stamps/stamp-rat.png";
import stampSub from "../../res/stamps/stamp-sub.png";
import "./RatingStamp.scss";

let stampSeq = 0;

/** Inked career-verdict seal: a procedural SVG frame (double border + moiré
 *  weave + ink-rough displacement filter) around pre-rendered glyph bitmaps.
 *
 *  The glyphs are baked to PNGs by `scripts/gen_stamp_bitmaps.py` (calligraphy
 *  fonts: 神 in 毛体, the rest in 鲁迅行书); the four-char tags are recut from
 *  the 2x2 seal face into ONE horizontal line by `scripts/recut_stamp_bitmaps.py`
 *  (过街老鼠 et al. read left-to-right on a classic elongated seal face). The
 *  fonts themselves are commercial / unclear-license and are NOT bundled —
 *  bitmaps only, so the seals look identical everywhere. Displacement seeds
 *  are fixed per kind → deterministic ink.
 *   - "miracle" (神了): PR ≥ 2100 over 500+ battles
 *   - "ape" (海猴): PR < 750 with winrate ≥ 40%
 *   - "maggot" (蛆): PR < 750 with winrate < 40%
 *   - "rat" (过街老鼠): hidden profile — no stats to grade, hiding is the tell
 *   - "air" (空中小人) / "sub" (水下小人): composition tags for CV / submarine
 *     mains (career share > 20% over 200+ battles)
 *
 *  A user-imported custom picture (settings' seal customizer →
 *  commands::stamps) replaces the whole seal face — the procedural frame is
 *  skipped so the user's art shows as-is.
 *
 * The seals are a Chinese-community artifact — they render nothing under any
 * other UI language, and a seal switched off individually (statsPrefs
 * sealDisabled) never renders either. */
const STAMP_GLYPHS: Record<StampKind, string> = {
  miracle: stampMiracle,
  ape: stampApe,
  maggot: stampMaggot,
  rat: stampRat,
  air: stampAir,
  sub: stampSub,
};
const STAMP_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "海猴",
  maggot: "蛆",
  rat: "过街老鼠",
  air: "空中小人",
  sub: "水下小人",
};
const STAMP_SEED: Record<StampKind, number> = {
  miracle: 7,
  ape: 13,
  maggot: 31,
  rat: 44,
  air: 21,
  sub: 5,
};
/** Four-char seals use the elongated 3:1 face (their bitmaps are 800x200);
 *  the single-glyph verdicts keep the square face. */
const WIDE_FACES: ReadonlySet<StampKind> = new Set(["rat", "air", "sub"]);

export default defineComponent({
  name: "RatingStamp",
  props: {
    kind: { type: String as PropType<StampKind>, required: true },
    /** Rendered height in px (the wide 3:1 faces scale width from it). */
    size: { type: Number, default: 64 },
    /** "mini" drops the moiré weave for tiny sizes (live roster rows). */
    variant: { type: String as PropType<"full" | "mini">, default: "full" },
  },
  setup(props) {
    const { uiLocale } = useLanguage();
    const uid = `stamp-${++stampSeq}`;

    return () => {
      // Three AND-composed gates: zh-only bitmaps, the settings master
      // switch's seals toggle is checked by the hosts, and this per-kind
      // kill switch from the seal customizer.
      if (!uiLocale.value.startsWith("zh")) return null;
      if (statsPrefsState.value.sealDisabled[props.kind]) return null;
      const wide = WIDE_FACES.has(props.kind);
      const width = wide ? props.size * 3 : props.size;
      const text = STAMP_TEXT[props.kind];
      const cls = [
        "rating-stamp",
        `rating-stamp--${props.kind}`,
        wide ? "rating-stamp--wide" : undefined,
      ];
      const custom = stampOverrideUrl(props.kind);
      if (custom != null) {
        // User's own picture replaces the procedural face entirely (frame
        // and all) — same footprint, same tilt, nothing else in the way.
        return (
          <img
            class={cls}
            src={custom}
            alt={text}
            width={width}
            height={props.size}
            style={{ objectFit: "contain" }}
            role="img"
            aria-label={text}
            title={text}
          />
        );
      }
      const id = (part: string) => `${uid}-${part}`;
      const url = (part: string) => `url(#${id(part)})`;
      const mini = props.variant === "mini";
      return (
        <svg
          class={cls}
          width={width}
          height={props.size}
          viewBox={wide ? "0 0 300 100" : "0 0 100 100"}
          role="img"
          aria-label={text}
        >
          <defs>
            {/* Two line weaves a hair apart in angle — their interference
                leaves the faint moiré of a cheap rubber stamp. userSpaceOnUse
                tiles identically across the square and wide faces. */}
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
                {/* Moiré fills the space between the two frames — the wide
                    face stretches it sideways, the weave itself is unchanged
                    (the extra 纹路 the long face needs comes free). */}
                <rect x="14" y="14" width={wide ? 272 : 71} height="71" fill={url("weave-a")} />
                <rect x="14" y="14" width={wide ? 272 : 71} height="71" fill={url("weave-b")} />
              </g>
            )}
            {wide ? (
              <>
                <rect class="rating-stamp__frame" x="4" y="4" width="292" height="92" rx="7" stroke-width="6" />
                <rect class="rating-stamp__frame" x="13.5" y="13.5" width="273" height="73" rx="3" stroke-width="2" />
              </>
            ) : (
              <>
                <rect class="rating-stamp__frame" x="5" y="5" width="90" height="90" rx="7" stroke-width="6" />
                <rect class="rating-stamp__frame" x="14.5" y="14.5" width="71" height="71" rx="3" stroke-width="2" />
              </>
            )}
            {/* Glyph bitmap (pre-centered cinnabar: single-glyph verdicts,
                one-line composition tags), inset to sit well inside the
                inner frame — full-bleed glyphs read too heavy at seal
                sizes. The wide face's image box keeps the bitmap's 4:1
                aspect so the recut glyphs are never stretched. */}
            {wide ? (
              <image href={STAMP_GLYPHS[props.kind]} x="18" y="17" width="264" height="66" />
            ) : (
              <image href={STAMP_GLYPHS[props.kind]} x="17" y="17" width="66" height="66" />
            )}
          </g>
        </svg>
      );
    };
  },
});
