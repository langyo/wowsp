/**
 * Inline vector art for the live-battle page's idle / waiting states (see
 * `LiveIdleGuide.tsx` and LiveBattlePanel's empty branch). This package has
 * no .svg asset pipeline — custom marks are drawn as inline JSX SVG with
 * path constants, following the PlatformIcon convention — and every part is
 * themed through token classes in `liveGuideArt.scss` so the art tracks both
 * themes and any accent for free.
 */
import { defineComponent } from "vue";

import "./liveGuideArt.scss";

/** Step 1 — a destroyer heading out to sea: "start a battle in game". */
const HULL_PATH = "M26 54 H100 L112 62 L105 67 H30 L26 60 Z";
const SUPERSTRUCTURE_PATH = "M33 54 V48.5 H45.5 V38.5 L56 35.5 V42.5 H78 V54 Z";
const TURRET_PATH = "M85 54 V48.5 H96 L101.5 54 Z";
const PENNANT_PATH = "M68 25 L80 28 L68 31 Z";
const SPARK_PATH =
  "M118 32 L119.6 35.9 L123.5 37.5 L119.6 39.1 L118 43 L116.4 39.1 L112.5 37.5 L116.4 35.9 Z";
const WAVE_PATH =
  "M10 71 Q17 65 24 71 T38 71 T52 71 T66 71 T80 71 T94 71 T108 71 T122 71";
const WAVE_BACK_PATH =
  "M24 79 Q31 73 38 79 T52 79 T66 79 T80 79 T94 79 T108 79";

export const BattleStartArt = defineComponent({
  name: "BattleStartArt",
  setup() {
    return () => (
      <svg viewBox="0 0 132 88" class="live-guide-art" aria-hidden="true">
        <path class="live-guide-art__ln-muted-thin" d="M10 60 H20" />
        <path class="live-guide-art__ln-muted-thin" d="M7 66 H18" />
        <path class="live-guide-art__fill-soft live-guide-art__ln-accent" d={HULL_PATH} />
        <path
          class="live-guide-art__fill-soft live-guide-art__ln-accent"
          d={SUPERSTRUCTURE_PATH}
        />
        <path class="live-guide-art__ln-muted-thin" d="M61 47.5 H74" />
        <path class="live-guide-art__ln-accent" d="M68 42.5 V25" />
        <path class="live-guide-art__fill-accent" d={PENNANT_PATH} />
        <path class="live-guide-art__fill-soft live-guide-art__ln-accent" d={TURRET_PATH} />
        <path class="live-guide-art__ln-accent" d="M95.5 49.5 L107 47.5" />
        <path class="live-guide-art__ln-muted" d={WAVE_PATH} />
        <path class="live-guide-art__ln-muted-thin" d={WAVE_BACK_PATH} />
        <path class="live-guide-art__fill-accent" d={SPARK_PATH} />
      </svg>
    );
  },
});

/** Step 2 — the scoreboard framed by detection brackets over a keyboard
 *  whose Tab keycap is highlighted: "hold Tab to start detection". */
export const TabHoldArt = defineComponent({
  name: "TabHoldArt",
  setup() {
    return () => (
      <svg viewBox="0 0 132 88" class="live-guide-art" aria-hidden="true">
        <rect
          class="live-guide-art__fill-soft"
          x="34"
          y="10"
          width="64"
          height="30"
          rx="3"
        />
        <rect
          class="live-guide-art__ln-muted-thin"
          x="34"
          y="10"
          width="64"
          height="30"
          rx="3"
        />
        <path class="live-guide-art__ln-accent-thin" d="M40 17 H62" />
        <circle class="live-guide-art__fill-accent" cx="91" cy="17" r="1.6" />
        <path class="live-guide-art__ln-muted-thin" d="M40 24 H92" />
        <path class="live-guide-art__ln-muted-thin" d="M40 30 H84" />
        <path class="live-guide-art__ln-muted-thin" d="M40 36 H92" />
        <path class="live-guide-art__ln-accent" d="M30 19 V7 H42" />
        <path class="live-guide-art__ln-accent" d="M102 19 V7 H90" />
        <path class="live-guide-art__ln-accent" d="M30 31 V43 H42" />
        <path class="live-guide-art__ln-accent" d="M102 31 V43 H90" />
        <path class="live-guide-art__ln-accent" d="M34 48.5 L39 52.5 L44 48.5" />
        <rect class="live-guide-art__ln-muted" x="26" y="57" width="80" height="20" rx="4" />
        <rect
          class="live-guide-art__fill-soft live-guide-art__ln-accent"
          x="30"
          y="61"
          width="18"
          height="12"
          rx="2.5"
        />
        <text class="live-guide-art__txt" x="39" y="68.8" text-anchor="middle" font-size="5.5">
          Tab
        </text>
        <rect class="live-guide-art__ln-muted-thin" x="52" y="61" width="10" height="12" rx="2" />
        <rect class="live-guide-art__ln-muted-thin" x="66" y="61" width="10" height="12" rx="2" />
        <rect class="live-guide-art__ln-muted-thin" x="80" y="61" width="22" height="12" rx="2" />
      </svg>
    );
  },
});

/** Waiting-for-battle radar — a rotating sweep with two blinking contacts,
 *  shown while the game runs but no roster has appeared yet. */
const SWEEP_WEDGE = "M32 32 L32 10 A22 22 0 0 1 51.1 19.7 Z";

export const WaitingRadarArt = defineComponent({
  name: "WaitingRadarArt",
  setup() {
    return () => (
      <svg viewBox="0 0 64 64" class="live-guide-art" aria-hidden="true">
        <path
          class="live-guide-art__ln-muted-thin"
          d="M32 3.5 V9 M32 55 V60.5 M3.5 32 H9 M55 32 H60.5"
        />
        <circle class="live-guide-art__ln-muted" cx="32" cy="32" r="24" />
        <circle class="live-guide-art__ln-muted-thin" cx="32" cy="32" r="15.5" />
        <g class="live-guide-art__sweep">
          <path class="live-guide-art__fill-soft" d={SWEEP_WEDGE} />
          <path class="live-guide-art__ln-accent-thin" d="M32 32 L32 10" />
        </g>
        <circle class="live-guide-art__fill-accent" cx="32" cy="32" r="2.4" />
        <circle class="live-guide-art__fill-accent live-guide-art__blip" cx="43" cy="40" r="2.4" />
        <circle
          class="live-guide-art__fill-accent live-guide-art__blip live-guide-art__blip--late"
          cx="21.5"
          cy="20.5"
          r="2"
        />
      </svg>
    );
  },
});
