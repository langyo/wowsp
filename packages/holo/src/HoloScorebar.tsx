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

const CAP_COLORS: Record<HoloCapZone["owner"], string> = {
  ally: "var(--holo-ally, #4ade80)",
  enemy: "var(--holo-enemy, #f87171)",
  neutral: "var(--holo-neutral, #ffffff)",
};

// Diamond geometry (30-unit viewBox, same footprint as the in-game widget):
// the outline path starts at the TOP corner and runs clockwise, so a
// stroke-dasharray arc along it sweeps clockwise from 12 o'clock — the
// diamond's own edge IS the loading ring (no extra circle, no fill pie).
const DIAMOND_PATH = "M15 5.1 L24.9 15 L15 24.9 L5.1 15 Z";
const DIAMOND_PERIM = 4 * (24.9 - 15) * Math.SQRT2;

function CapChip({ cap }: { cap: HoloCapZone }) {
  const active = !!cap.capturing || !!cap.contested;
  const ownerColor = CAP_COLORS[cap.owner];
  // The rotating edge arc is coloured by the side accruing the capture
  // (ally green / enemy red) — white/red/green only, never yellow.
  const sweepColor = CAP_COLORS[cap.captureSide ?? cap.owner];
  const progress = Math.max(0, Math.min(1, cap.progress ?? 0));
  const dash = DIAMOND_PERIM * progress;
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
      {/* Idle = square (larger, roomier letter padding); capturing = diamond
          (kept at the in-game footprint). The two shapes are independent
          sizes, not a 45° rotation of the same square. */}
      <svg viewBox="0 0 30 30" width="26" height="26" aria-hidden="true">
        {active ? (
          <>
            {/* owner-coloured body + owner outline */}
            <path d={DIAMOND_PATH} fill={ownerColor} fill-opacity="0.55" />
            <path
              d={DIAMOND_PATH} fill="none"
              stroke={ownerColor} stroke-width="1.8" stroke-linejoin="round"
            />
            {/* clockwise edge sweep (the loading ring), from 12 o'clock */}
            <path
              d={DIAMOND_PATH} fill="none"
              stroke={sweepColor} stroke-width="3"
              stroke-linecap="round"
              stroke-dasharray={`${dash} ${DIAMOND_PERIM}`}
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
