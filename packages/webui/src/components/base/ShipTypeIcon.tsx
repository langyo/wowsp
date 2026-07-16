import { defineComponent, computed, type PropType } from "vue";

/**
 * WoWS ship-type icon — the triangular silhouettes the game uses on its minimap
 * and battle HUD. Each hull class has a distinct notch count under the triangle
 * so ship types are readable at a glance without text:
 *
 *   Destroyer  (DD) — bare triangle
 *   Cruiser    (CA) — triangle + 1 notch
 *   Battleship (BB) — triangle + 2 notches
 *   AirCarrier (CV) — wide flat-topped hull (flight-deck profile)
 *   Submarine  (SS) — teardrop
 *
 * The icon inherits `currentColor`, so tint it via the parent's `color` style.
 * `size` sets the square viewBox dimension in px (default 14).
 *
 * The `type` prop takes a WG ShipInfo.type string (Battleship / Cruiser /
 * Destroyer / AirCarrier / Submarine); unknown values render a "?".
 */

const NOTCH_Y = 18.5; // y of the notch line(s) below the triangle base
const TRI = "M12 3 L22 16 L2 16 Z"; // upward triangle, 24×24 viewBox

export default defineComponent({
  name: "ShipTypeIcon",
  props: {
    type: { type: String as PropType<string>, required: true },
    size: { type: Number, default: 14 },
  },
  setup(props) {
    /** Notch count: 0=DD, 1=CA, 2=BB; carriers & subs use custom shapes. */
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
      return (
        <svg
          width={props.size}
          height={props.size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          {k === "dd" ? (
            <path d={TRI} fill="currentColor" fill-opacity="0.25" />
          ) : k === "ca" ? (
            <g>
              <path d={TRI} fill="currentColor" fill-opacity="0.25" />
              <line x1="6" y1={NOTCH_Y} x2="18" y2={NOTCH_Y} />
            </g>
          ) : k === "bb" ? (
            <g>
              <path d={TRI} fill="currentColor" fill-opacity="0.25" />
              <line x1="6" y1={NOTCH_Y} x2="18" y2={NOTCH_Y} />
              <line x1="8" y1={NOTCH_Y + 2.5} x2="16" y2={NOTCH_Y + 2.5} />
            </g>
          ) : k === "cv" ? (
            // Flat-topped flight deck: wide rectangle with an island bump.
            <g>
              <path d="M2 15 L22 15 L20 19 L4 19 Z" fill="currentColor" fill-opacity="0.25" />
              <rect x="15" y="11" width="3" height="4" rx="0.5" />
            </g>
          ) : k === "ss" ? (
            // Teardrop hull with a conning tower.
            <g>
              <path d="M3 16 C3 12 8 10 12 10 C16 10 21 12 21 16 Z" fill="currentColor" fill-opacity="0.25" />
              <rect x="10" y="7" width="4" height="3" rx="0.5" />
            </g>
          ) : (
            <text x="12" y="17" text-anchor="middle" font-size="13" fill="currentColor" stroke="none">?</text>
          )}
        </svg>
      );
    };
  },
});
