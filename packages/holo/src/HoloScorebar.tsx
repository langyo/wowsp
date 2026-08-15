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

// Concrete hex values — SVG presentation attributes (fill/stroke) take
// these directly; CSS var() strings render black in some attribute contexts.
const CAP_COLORS: Record<HoloCapZone["owner"], string> = {
  ally: "#4ade80",
  enemy: "#f87171",
  neutral: "#ffffff",
};

// Diamond geometry (30-unit viewBox): the outline path starts at the TOP
// corner and runs clockwise, so a clip rect growing downward fills the
// diamond top-to-bottom with the capturing side's colour as progress
// accrues (in-game behaviour), while the outline stays the owner's.
const DIAMOND_PATH = "M15 1.5 L28.5 15 L15 28.5 L1.5 15 Z";

/** Unique clip ids per rendered chip (SVG clipPath is id-referenced). */
let clipSeq = 0;

function CapChip({ cap }: { cap: HoloCapZone }) {
  const active = !!cap.capturing || !!cap.contested;
  const ownerColor = CAP_COLORS[cap.owner];
  // The capture fill is coloured by the side accruing the capture (ally
  // green / enemy red) — white/red/green only, never yellow.
  const fillColor = CAP_COLORS[cap.captureSide ?? cap.owner];
  const progress = Math.max(0, Math.min(1, cap.progress ?? 0));
  const uid = `capfill${clipSeq++}`;
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
            <defs>
              <clipPath id={uid}>
                <path d={DIAMOND_PATH} />
              </clipPath>
            </defs>
            {/* owner body behind the fill */}
            <path d={DIAMOND_PATH} fill={ownerColor} fill-opacity="0.3" />
            {/* capture fill: grows top→bottom with progress, clipped to the
                diamond (the fill covers the whole diamond width, not just a
                corner) */}
            <rect
              x="0" y="0" width="30" height={30 * progress}
              fill={fillColor} fill-opacity="0.85"
              clip-path={`url(#${uid})`}
            />
            {/* owner outline */}
            <path
              d={DIAMOND_PATH} fill="none"
              stroke={ownerColor} stroke-width="1.8" stroke-linejoin="round"
            />
          </>
        ) : (
          <rect
            x={5} y={5} width={20} height={20}
            fill="none" stroke={ownerColor} stroke-width="1.8"
          />
        )}
        <text
          x="15" y="19.5" text-anchor="middle" font-size="12" font-weight="800"
          fill={active ? "#ffffff" : ownerColor}
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
  const url = holoShipIconUrl(ship.shipType, variant);
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
