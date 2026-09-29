import { defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";
import { stampOverrideUrl } from "@/stores/stampOverrides";
import type { StampKind } from "@/utils/winrate";
import "./RatingStamp.scss";

let stampSeq = 0;

/** Inked career-verdict seal: a procedural SVG frame (double border + moiré
 *  weave + ink-rough displacement filter) around the verdict wording as
 *  PLAIN TEXT — no pre-rendered calligraphy bitmaps anymore, so the glyphs
 *  follow the app font everywhere and stay crisp at every size. Four-char
 *  tags lay out as the classic 2x2 seal face (空中 over 小人, 过街 over
 *  老鼠), the rest as one centered line. Displacement seeds are fixed per
 *  kind → deterministic ink.
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
 *  Hovering a seal shows its award criteria (stats.json `stats.seal*Desc`
 *  keys) as the native tooltip — the same copy the seal customizer rows use.
 *
 *  The seals are a Chinese-community artifact — they render nothing under any
 *  other UI language, and a seal switched off individually (statsPrefs
 *  sealDisabled) never renders either. */
const STAMP_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "海猴",
  maggot: "蛆",
  rat: "过街老鼠",
  air: "空中小人",
  sub: "水下小人",
};
/** The seal face's text lines — four-char tags press as two lines of two
 *  (the classic 2x2 seal layout), the rest as one line. */
const STAMP_LINES: Record<StampKind, string[]> = {
  miracle: ["神了"],
  ape: ["海猴"],
  maggot: ["蛆"],
  rat: ["过街", "老鼠"],
  air: ["空中", "小人"],
  sub: ["水下", "小人"],
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
};
const STAMP_SEED: Record<StampKind, number> = {
  miracle: 7,
  ape: 13,
  maggot: 31,
  rat: 44,
  air: 21,
  sub: 5,
};

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
      // Three AND-composed gates: zh-only wording, the settings master
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
      const lines = STAMP_LINES[props.kind];
      // Face metrics: the 2x2 two-line layout at 28, a lone glyph big at
      // 46, a two-char line at 30 — each keeps the wording inside the
      // inner frame with seal-appropriate air.
      const fontSize = lines.length === 2 ? 28 : lines[0].length === 1 ? 46 : 30;
      const yOf = (i: number) => (lines.length === 2 ? (i === 0 ? 37 : 71) : 50);
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
            <rect class="rating-stamp__frame" x="5" y="5" width="90" height="90" rx="7" stroke-width="6" />
            <rect class="rating-stamp__frame" x="14.5" y="14.5" width="71" height="71" rx="3" stroke-width="2" />
            {/* The verdict wording as plain text, centered in the inner
                frame (2x2 for the four-char tags) — the wording IS the
                face now, crisp at every rendered size. */}
            {lines.map((line, i) => (
              <text
                class="rating-stamp__text"
                key={line}
                x="50"
                y={yOf(i)}
                font-size={fontSize}
                text-anchor="middle"
                dominant-baseline="central"
              >
                {line}
              </text>
            ))}
          </g>
        </svg>
      );
    };
  },
});
