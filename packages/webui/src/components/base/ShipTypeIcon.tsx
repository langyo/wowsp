import { defineComponent, computed, type PropType } from "vue";

/**
 * WoWS ship-class glyph, reproduced pixel-for-pixel from the game's own icon
 * atlas (`gui/service_kit/ship_classes/icon_default_*.png`, 27×27): horizontal
 * shapes with the arrow pointing right, solid fill plus faint (~25% opacity)
 * internal differentiation lines, exactly like the in-game team list:
 *
 *   Destroyer  (DD) — plain right-pointing triangle
 *   Cruiser    (CA) — pentagon arrow + one diagonal line
 *   Battleship (BB) — pentagon arrow + two parallel diagonals
 *   AirCarrier (CV) — rectangle (split into two squares by a horizontal line)
 *                     + right-pointing triangle
 *   Submarine  (SS) — vertical bar + right-pointing triangle
 *
 * The icon inherits `currentColor`, so tint it via the parent's `color` style.
 * `size` sets the rendered edge in px (default 14).
 *
 * The `type` prop takes a WG ShipInfo.type string (Battleship / Cruiser /
 * Destroyer / AirCarrier / Submarine); unknown values render a "?".
 */

const SEAM_OPACITY = 0.25;
const SEAM_WIDTH = 1;

// 27×27 native coordinates (the game's atlas size), traced from
// `gui/service_kit/ship_classes/icon_default_*.png` alpha masks.
const SHAPES: Record<"dd" | "ca" | "bb" | "cv" | "ss", { fill: string; seams: string[] }> = {
  dd: {
    // Right-pointing triangle: vertical left edge x4.5, tip (23, 13).
    fill: "M4.5 8.5 L23 13 L4.5 17.5 Z",
    seams: [],
  },
  ca: {
    // Pentagonal arrow: (4.5,8) (19,8) tip (23,13) (19,18) (4.5,18).
    fill: "M4.5 8 L19 8 L23 13 L19 18 L4.5 18 Z",
    seams: ["M14.5 8.5 L9.5 17.5"],
  },
  bb: {
    fill: "M4.5 8 L19 8 L23 13 L19 18 L4.5 18 Z",
    seams: ["M13.5 8.5 L8.5 17.5", "M17 8.5 L12.5 17.5"],
  },
  cv: {
    // Rectangle + triangle union; the horizontal line at y13 splits the
    // rectangle into two squares, the vertical seam at x15.2 marks the
    // rectangle/triangle boundary.
    fill: "M4.5 8 L14.5 8 L16 8 L23 13 L16 18 L14.5 18 L4.5 18 Z",
    seams: ["M4.5 13 L14.5 13", "M15.2 8 L15.2 18"],
  },
  ss: {
    // Vertical bar + separate right-pointing triangle.
    fill: "M4 8.5 L5.5 8.5 L5.5 17.5 L4 17.5 Z M8.5 9 L23 13 L8.5 17 Z",
    seams: [],
  },
};

export default defineComponent({
  name: "ShipTypeIcon",
  props: {
    type: { type: String as PropType<string>, required: true },
    size: { type: Number, default: 14 },
  },
  setup(props) {
    const kind = computed<"dd" | "ca" | "bb" | "cv" | "ss" | "?" | null>(() => {
      const t = props.type?.toLowerCase();
      if (!t) return "?";
      if (t.includes("battleship")) return "bb";
      if (t.includes("cruiser")) return "ca";
      if (t.includes("destroyer")) return "dd";
      if (t.includes("aircarrier") || t.includes("aircar")) return "cv";
      if (t.includes("submarine")) return "ss";
      return "?";
    });

    return () => {
      const k = kind.value;
      if (k === "?" || k === null) {
        return (
          <svg
            width={props.size}
            height={props.size}
            viewBox="0 0 27 27"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <text x="13.5" y="19" text-anchor="middle" font-size="14" fill="currentColor" stroke="none">
              ?
            </text>
          </svg>
        );
      }
      const shape = SHAPES[k];
      return (
        <svg
          width={props.size}
          height={props.size}
          viewBox="0 0 27 27"
          fill="currentColor"
          stroke="none"
          aria-hidden="true"
        >
          <path d={shape.fill} />
          {shape.seams.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke="currentColor"
              stroke-width={SEAM_WIDTH}
              opacity={SEAM_OPACITY}
            />
          ))}
        </svg>
      );
    };
  },
});
