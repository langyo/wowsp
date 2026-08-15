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

function CapChip({ cap }: { cap: HoloCapZone }) {
  const active = !!cap.capturing || !!cap.contested;
  const ownerColor = CAP_COLORS[cap.owner];
  // The clockwise progress sweep is coloured by the side accruing the
  // capture (ally green / enemy red) — white/red/green only, never yellow.
  const sweepColor = CAP_COLORS[cap.captureSide ?? cap.owner];
  const deg = Math.max(0, Math.min(360, Math.round((cap.progress ?? 0) * 360)));
  // Letter: team colour on the idle square; white on a coloured diamond;
  // dark on a white (neutral) diamond so it stays readable.
  const letterColor = !active
    ? ownerColor
    : cap.owner === "neutral"
      ? "rgba(10, 16, 26, 0.92)"
      : "#ffffff";
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
      {/* Idle = square (roomier letter padding); capturing = diamond with a
          clockwise conic sweep masked to the diamond shape. The two are
          independent sizes — NOT a plain 45° rotation of each other. */}
      <span
        class={[
          "holo-scorebar__chip",
          active ? "holo-scorebar__chip--diamond" : "holo-scorebar__chip--square",
        ].join(" ")}
        style={{ color: ownerColor }}
      >
        {active ? (
          <span
            class="holo-scorebar__chip-sweep"
            style={
              {
                "--holo-sweep-color": sweepColor,
                "--holo-sweep-deg": `${deg}deg`,
              } as Record<string, string>
            }
          />
        ) : null}
        <span class="holo-scorebar__chip-letter" style={{ color: letterColor }}>
          {cap.letter}
        </span>
      </span>
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
