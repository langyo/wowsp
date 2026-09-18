import { defineComponent, type PropType } from "vue";

import type { CareerStamp } from "@/utils/winrate";
import "./RatingStamp.scss";

let stampSeq = 0;

/** Inked career-verdict seal, drawn as pure SVG. Everything is deterministic:
 *  the moiré weave angles and the ink-rough displacement seeds are fixed, so
 *  the same player always sees the same stamp.
 *   - "miracle" (神了): long-term purple-tier+ career (PR ≥ 2100 over 500+ battles)
 *   - "ape" (海猴): red-tier career (PR < 750) */
export default defineComponent({
  name: "RatingStamp",
  props: {
    kind: { type: String as PropType<CareerStamp>, required: true },
    /** Rendered edge length in px. */
    size: { type: Number, default: 64 },
    /** "mini" drops the moiré weave for tiny sizes (live roster rows). */
    variant: { type: String as PropType<"full" | "mini">, default: "full" },
  },
  setup(props) {
    const uid = `stamp-${++stampSeq}`;
    const text = () => (props.kind === "miracle" ? "神了" : "海猴");

    return () => {
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
          aria-label={text()}
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
                seed={props.kind === "miracle" ? 7 : 13}
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
            <text
              class="rating-stamp__text"
              x="50"
              y="51"
              text-anchor="middle"
              dominant-baseline="central"
              stroke="currentColor"
              stroke-width="1.1"
              stroke-linejoin="round"
              paint-order="stroke"
            >
              {text()}
            </text>
          </g>
        </svg>
      );
    };
  },
});
