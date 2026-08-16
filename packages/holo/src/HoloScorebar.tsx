import { defineComponent, type PropType } from "vue";
import type { HoloCapZone, HoloHudState, HoloShip } from "./types";
import { holoShipIconUrl } from "./icons";
import "./HoloScorebar.scss";

/**
 * HoloScorebar — top battle scoreboard shared by the app and the site.
 *
 * Layout mirrors the in-game strip: ally score · cap letters · enemy score,
 * with an optional ship-icon row underneath (game HUD icons, sunk greyed).
 * Cap letters follow the in-game widget: a plain square when held/neutral
 * that turns into a 45° diamond with a progress ring while being captured
 * (and pulses when contested).
 */

// Cap colours resolve from the CSS custom properties declared on
// .holo-scorebar (--holo-ally / --holo-enemy / --holo-neutral): the SVG
// shapes use currentColor + a var()-driven inline fill, so the theme can
// retint the NEUTRAL letter (white on dark glass, slate on light glass)
// without touching the team colours.

// Diamond geometry (30-unit viewBox): the outline starts at the TOP corner
// and runs CLOCKWISE. The capture progress is a stroke-dash segment walking
// that edge like the in-game widget (a loading ring on the diamond's EDGE —
// never an interior fill); the ring rides a slightly larger diamond so it
// reads outside the owner outline.
const DIAMOND_PATH = "M15 1.5 L28.5 15 L15 28.5 L1.5 15 Z";
// Progress-ring path: same diamond expanded ~2.2 units from centre.
const RING_PATH = "M15 -0.7 L30.7 15 L15 30.7 L-0.7 15 Z";
// Ring perimeter (4 x hypot(15.7, 15.7)) for the dash maths.
const RING_LEN = 4 * Math.hypot(15.7, 15.7);

function CapChip({ cap }: { cap: HoloCapZone }) {
  const active = !!cap.capturing || !!cap.contested;
  // The progress ring is coloured by the side accruing the capture (ally
  // green / enemy red) — white/red/green only, never yellow. Resolved as a
  // CSS custom property (inline style) so the theme flip in the SCSS
  // applies; owner tint comes from currentColor (class sets `color`).
  const fillVar = `var(--holo-${cap.captureSide ?? cap.owner})`;
  const progress = Math.max(0, Math.min(1, cap.progress ?? 0));
  return (
    <span
      class={[
        "holo-scorebar__cap",
        `holo-scorebar__cap--${cap.owner}`,
        active ? "is-active" : "",
        cap.contested ? "is-contested" : "",
      ].join(" ")}
      title={cap.hint}
    >
      {/* Idle = square (roomier letter padding); capturing = diamond (a bit
          larger than before, matching the in-game widget footprint). The two
          shapes are independent sizes, not a 45° rotation of the same square. */}
      <svg viewBox="0 0 30 30" width="28" height="28" aria-hidden="true">
        {active ? (
          <>
            {/* owner body: faint interior tint (decor only — the PROGRESS
                lives on the edge ring below, like the in-game widget) */}
            <path d={DIAMOND_PATH} fill="currentColor" fill-opacity="0.18" />
            {/* owner outline */}
            <path
              d={DIAMOND_PATH} fill="none"
              stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
            />
            {/* capture progress: a clockwise walking dash along the EDGE
                (loading-ring). stroke-dasharray carves the travelled arc. */}
            <path
              d={RING_PATH} fill="none"
              style={{ stroke: fillVar }}
              stroke-width="2.6" stroke-linecap="round"
              stroke-dasharray={`${(RING_LEN * progress).toFixed(2)} ${RING_LEN.toFixed(2)}`}
            />
          </>
        ) : (
          <rect
            x={5} y={5} width={20} height={20}
            fill="none" stroke="currentColor" stroke-width="1.8"
          />
        )}
        <text
          x="15" y="19.5" text-anchor="middle" font-size="12" font-weight="800"
          fill={active ? "#ffffff" : "currentColor"}
          paint-order="stroke"
          stroke={active ? "rgba(0, 0, 0, 0.85)" : "none"}
          stroke-width={active ? "1.3" : "0"}
        >
          {cap.letter}
        </text>
      </svg>
    </span>
  );
}

function ShipIcon({ ship }: { ship: HoloShip }) {
  const variant = ship.dead ? "sunk" : ship.role === "enemy" ? "enemy" : "ally";
  // Sunk auxiliaries have no sunk art — fall back to the sunk cruiser icon
  // so a missing asset never blanks a slot in the strip.
  let url = holoShipIconUrl(ship.shipType, variant);
  if (!url && variant === "sunk") url = holoShipIconUrl("cruiser", "sunk");
  if (!url) return null;
  return (
    <img
      class={["holo-scorebar__ship", ship.dead ? "is-sunk" : ""].join(" ")}
      src={url}
      alt={ship.shipType ?? ""}
      width="15"
      height="15"
    />
  );
}

export default defineComponent({
  name: "HoloScorebar",
  props: {
    state: { type: Object as PropType<HoloHudState>, required: true },
  },
  setup(props) {
    return () => {
      const s = props.state;
      // Team order is owned by the caller (the app mirrors icons by ship
      // size; the site sorts alive-first) — we only split by side.
      const allies = s.ships.filter((sh) => sh.role !== "enemy");
      const enemies = s.ships.filter((sh) => sh.role === "enemy");
      return (
        <div class="holo-scorebar">
          <span class="holo-scorebar__main">
            <span class="holo-scorebar__score holo-scorebar__score--ally">
              <span class="holo-scorebar__dot holo-scorebar__dot--ally" />
              {s.scoreAlly}
            </span>
            <span class="holo-scorebar__caps">
              {s.caps.map((c) => <CapChip key={c.letter} cap={c} />)}
            </span>
            <span class="holo-scorebar__score holo-scorebar__score--enemy">
              {s.scoreEnemy}
              <span class="holo-scorebar__dot holo-scorebar__dot--enemy" />
            </span>
          </span>
          {s.ships.length ? (
            <span class="holo-scorebar__ships">
              {allies.map((sh, i) => <ShipIcon key={`a${i}`} ship={sh} />)}
              <span class="holo-scorebar__ships-sep" />
              {enemies.map((sh, i) => <ShipIcon key={`e${i}`} ship={sh} />)}
            </span>
          ) : null}
        </div>
      );
    };
  },
});
