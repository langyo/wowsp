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
  neutral: "var(--holo-neutral, rgba(255,255,255,0.55))",
};

/** Unique clip ids per rendered chip (SVG clipPath must be id-referenced). */
let clipSeq = 0;

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function CapChip({ cap, uid }: { cap: HoloCapZone; uid: string }) {
  const active = !!cap.capturing || !!cap.contested;
  const ownerColor = CAP_COLORS[cap.owner];
  const ringColor = cap.contested
    ? "var(--holo-contested, #f5b85c)"
    : ownerColor;
  const fillColor = active
    ? cap.contested
      ? "var(--holo-contested, #f5b85c)"
      : cap.owner === "neutral"
        ? "var(--holo-capture, #4ade80)"
        : ownerColor
    : ownerColor;
  // In-game cap widget: a square that rotates 45° into a diamond while
  // capturing — the diamond fills from its top corner as progress accrues
  // (clipped fill, no extra progress ring), then rotates back to a filled
  // square once the point is held.
  const rotated = active;
  const bodyOpacity = active ? 0.9 : cap.progress >= 1 ? 0.85 : 0;
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
      <svg viewBox="0 0 30 30" width="26" height="26" aria-hidden="true">
        <defs>
          <clipPath id={uid}>
            <rect x="8" y="8" width="14" height="14" />
          </clipPath>
        </defs>
        <g
          class="holo-scorebar__chip"
          style={{
            transform: rotated ? "rotate(45deg)" : "rotate(0deg)",
          }}
        >
          {/* diamond body — clipped fill from the top corner */}
          <rect
            x="8" y="8" width="14" height="14"
            fill="transparent"
            class="holo-scorebar__fill"
            style={{ clipPath: `url(#${uid})` }}
          />
          {/* progress fill: grows downward inside the diamond clip */}
          <rect
            x="8" y="8" width="14" height={Math.max(0, Math.min(1, cap.progress)) * 14}
            fill={fillColor}
            fill-opacity={bodyOpacity}
            class="holo-scorebar__fillbar"
            style={{ clipPath: `url(#${uid})` }}
          />
          {/* border */}
          <rect
            x="8" y="8" width="14" height="14" fill="none"
            stroke={active ? ringColor : ownerColor}
            stroke-width="1.8"
            class="holo-scorebar__frame"
          />
        </g>
        <text
          x="15" y="20" text-anchor="middle" font-size="14" font-weight="800"
          fill={cap.owner === "neutral" && !active ? "var(--holo-cap-text, rgba(255,255,255,0.75))" : "#fff"}
          style={{ textShadow: "0 1px 2px rgba(0,0,0,0.9)" }}
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
              {s.caps.map((c) => <CapChip key={c.letter} cap={c} uid={`capclip${clipSeq++}`} />)}
            </span>
            <span class="holo-scorebar__score holo-scorebar__score--enemy">
              {s.scoreEnemy}
              <span class="holo-scorebar__dot holo-scorebar__dot--enemy" />
            </span>
            {s.duration > 0 ? (
              <span class="holo-scorebar__time">-{fmt(s.duration - s.time)}</span>
            ) : null}
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
