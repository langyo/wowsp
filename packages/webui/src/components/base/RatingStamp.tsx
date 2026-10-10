import { defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";
import { stampOverrideUrl } from "@/stores/stampOverrides";
import type { StampKind } from "@/utils/winrate";
import stampAir from "../../res/stamps/stamp-air.png";
import stampAirApe from "../../res/stamps/stamp-air-ape.png";
import stampAirMiracle from "../../res/stamps/stamp-air-miracle.png";
import stampAirVeteran from "../../res/stamps/stamp-air-veteran.png";
import stampApe from "../../res/stamps/stamp-ape.png";
import stampMaggot from "../../res/stamps/stamp-maggot.png";
import stampMiracle from "../../res/stamps/stamp-miracle.png";
import stampRat from "../../res/stamps/stamp-rat.png";
import stampSub from "../../res/stamps/stamp-sub.png";
import stampSubApe from "../../res/stamps/stamp-sub-ape.png";
import stampSubMiracle from "../../res/stamps/stamp-sub-miracle.png";
import stampSubVeteran from "../../res/stamps/stamp-sub-veteran.png";
import "./RatingStamp.scss";

let stampSeq = 0;

/** Inked career-verdict seal: a procedural SVG frame (double border + moiré
 *  weave + ink-rough displacement filter) around pre-rendered glyph bitmaps.
 *
 *  The glyphs are baked to PNGs by `scripts/gen_stamp_bitmaps.py` (calligraphy
 *  fonts: 神 in 毛体, the rest in 鲁迅行书; the four-char tags are laid out as
 *  a 2x2 seal face — 空中 over 小人, 过街 over 老鼠). The fonts themselves are
 *  commercial / unclear-license and are NOT bundled — bitmaps only, so the
 *  seals look identical everywhere. Displacement seeds are fixed per kind →
 *  deterministic ink.
 *   - "miracle" (神了): PR ≥ 2100 over 500+ battles
 *   - "ape" (猴): PR < 750 with winrate ≥ 40%
 *   - "maggot" (蛆): PR < 750 with winrate < 40%
 *   - "rat" (过街老鼠): hidden profile — no stats to grade, hiding is the tell
 *   - "air" (空中小人) / "sub" (水下小人): composition tags for CV / submarine
 *     mains (career share > 20% over 200+ battles)
 *   - "airVeteran" (空中老人) / "subVeteran" (水下老人): the veteran
 *     composition tier for a class share > 50% — replaces the minor (小人)
 *     seal for that class and never merges with career verdicts
 *   - "airMiracle" (空中神人) / "subMiracle" (水下神人) / "airApe" (空中小猴)
 *     / "subApe" (水下小猴): MERGED seals — composition tag + 神了 (resp. 猴)
 *     earned together; each replaces (consumes) both of its constituents,
 *     and 蛆 / 过街老鼠 suppress the composition tags entirely (see
 *     utils/winrate resolveStamps). Glyphs use the 鲁迅行书 font like the
 *     other composition / verdict tags, not 毛体.
 *
 *  A user-imported custom picture (settings' seal customizer →
 *  commands::stamps) replaces the whole seal face — the procedural frame is
 *  skipped so the user's art shows as-is.
 *
 *  Hovering a seal shows its award criteria (stats.json `stats.seal*Desc`
 *  keys) as the native tooltip — the same copy the seal customizer rows use.
 *
 *  Every surface outside the in-game Tab overlay shows the square 2x2
 *  faces; the Tab overlay chips press the verdict wording as PLAIN TEXT
 *  instead — their rows are far too short for a 2x2 face and the calligraphy
 *  is wasted at that size — see overlay/main.ts.
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
  airVeteran: stampAirVeteran,
  subVeteran: stampSubVeteran,
  airMiracle: stampAirMiracle,
  subMiracle: stampSubMiracle,
  airApe: stampAirApe,
  subApe: stampSubApe,
};
const STAMP_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "猴",
  maggot: "蛆",
  rat: "过街老鼠",
  air: "空中小人",
  sub: "水下小人",
  airVeteran: "空中老人",
  subVeteran: "水下老人",
  airMiracle: "空中神人",
  subMiracle: "水下神人",
  airApe: "空中小猴",
  subApe: "水下小猴",
};
/** Award-criteria tooltip keys (stats.json) — shared with the seal
 *  customizer rows; hover copy explains why a seal was earned. */
const STAMP_DESC_KEYS: Record<StampKind, string> = {
  miracle: "stats.sealMiracleDesc",
  ape: "stats.sealApeDesc",
  maggot: "stats.sealMaggotDesc",
  rat: "stats.sealRatDesc",
  air: "stats.sealAirDesc",
  sub: "stats.sealSubDesc",
  airVeteran: "stats.sealAirVeteranDesc",
  subVeteran: "stats.sealSubVeteranDesc",
  airMiracle: "stats.sealAirMiracleDesc",
  subMiracle: "stats.sealSubMiracleDesc",
  airApe: "stats.sealAirApeDesc",
  subApe: "stats.sealSubApeDesc",
};
const STAMP_SEED: Record<StampKind, number> = {
  miracle: 7,
  ape: 13,
  maggot: 31,
  rat: 44,
  air: 21,
  sub: 5,
  airVeteran: 17,
  subVeteran: 41,
  airMiracle: 26,
  subMiracle: 39,
  airApe: 11,
  subApe: 33,
};

export default defineComponent({
  name: "RatingStamp",
  props: {
    kind: { type: String as PropType<StampKind>, required: true },
    /** Rendered edge length in px. */
    size: { type: Number, default: 64 },
    /** "mini" drops the moiré weave for tiny sizes (live roster rows) and
     *  draws a THINNER, tighter frame so the glyph claims more of the face
     *  (the full variant keeps the classic wide double border — the deep
     *  stats surfaces have room for it, the roster rows do not). */
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
      const text = STAMP_TEXT[props.kind];
      const desc = t(STAMP_DESC_KEYS[props.kind]);
      const custom = stampOverrideUrl(props.kind);
      if (custom != null) {
        // User's own picture replaces the procedural face entirely (frame
        // and all) — same footprint, same tilt, nothing else in the way.
        return (
          <img
            class="rating-stamp"
            src={custom}
            alt={text}
            width={props.size}
            height={props.size}
            style={{ objectFit: "contain" }}
            role="img"
            aria-label={text}
            title={desc}
          />
        );
      }
      const id = (part: string) => `${uid}-${part}`;
      const url = (part: string) => `url(#${id(part)})`;
      const mini = props.variant === "mini";
      return (
        <svg
          class="rating-stamp"
          width={props.size}
          height={props.size}
          viewBox="0 0 100 100"
          role="img"
          aria-label={text}
        >
          <title>{desc}</title>
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
            {/* Frame geometry per variant (viewBox units): the full face
                keeps the classic wide double border; the mini face — the
                live roster / post-battle rows, where the seals were reported
                too small to read — presses a thinner frame closer to the
                edge and lets the glyph grow from 66 to 72 units, spending
                the freed border on ink instead. */}
            <rect
              class="rating-stamp__frame"
              x={mini ? 3.5 : 5}
              y={mini ? 3.5 : 5}
              width={mini ? 93 : 90}
              height={mini ? 93 : 90}
              rx={mini ? 6 : 7}
              stroke-width={mini ? 4 : 6}
            />
            <rect
              class="rating-stamp__frame"
              x={mini ? 10.5 : 14.5}
              y={mini ? 10.5 : 14.5}
              width={mini ? 79 : 71}
              height={mini ? 79 : 71}
              rx={mini ? 2.5 : 3}
              stroke-width={mini ? 1.5 : 2}
            />
            {/* Glyph bitmap (pre-centered cinnabar: single-glyph verdicts,
                2x2 composition tags), inset to sit well inside the inner
                frame — full-bleed glyphs read too heavy at seal sizes. */}
            <image
              href={STAMP_GLYPHS[props.kind]}
              x={mini ? 14 : 17}
              y={mini ? 14 : 17}
              width={mini ? 72 : 66}
              height={mini ? 72 : 66}
            />
          </g>
        </svg>
      );
    };
  },
});
