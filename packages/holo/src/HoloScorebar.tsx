import { defineComponent, type PropType } from "vue";
import type { HoloCapZone, HoloHudState, HoloShip } from "./types";
import { holoShipIconUrl } from "./icons";
import { useImage } from "./composables/useImage";
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
// and runs CLOCKWISE. Both the owner outline AND the progress arc stroke
// THE SAME path — the progress dash just draws on top with a wider stroke,
// so it always covers the outline exactly (a separate expanded path
// misaligned at the corners and its apex-first start rendered as a needle
// tip at low progress).
const DIAMOND_PATH = "M15 1.5 L28.5 15 L15 28.5 L1.5 15 Z";
// Perimeter for the dash maths: each corner-to-corner edge spans
// hypot(13.5, 13.5) ~ 19.09, four edges -> ~76.37.
const RING_LEN = 4 * Math.hypot(13.5, 13.5);

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
                lives on the edge arc below, like the in-game widget) */}
            <path d={DIAMOND_PATH} fill="currentColor" fill-opacity="0.18" />
            {/* Both strokes share ONE width so the sweeping arc and the
                owner outline read as a single uniform ring. */}
            {/* owner outline */}
            <path
              d={DIAMOND_PATH} fill="none"
              stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"
            />
            {/* capture progress: the SAME path, SAME width on top with a
                dash segment walking clockwise from the top corner — an
                exact overlay of the outline (loading-ring). */}
            <path
              d={DIAMOND_PATH} fill="none"
              style={{ stroke: fillVar }}
              stroke-width="2.4" stroke-linecap="round"
              stroke-dasharray={`${(RING_LEN * progress).toFixed(2)} ${RING_LEN.toFixed(2)}`}
            />
          </>
        ) : (
          <rect
            x={5} y={5} width={20} height={20}
            fill="none" stroke="currentColor" stroke-width="2.4"
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
      {/* ETA: seconds to complete the capture if the situation holds. */}
      {active && cap.etaSeconds != null && cap.etaSeconds > 0 ? (
        <span class="holo-scorebar__cap-eta">{Math.ceil(cap.etaSeconds)} s</span>
      ) : null}
    </span>
  );
}

/** URL selection for one ship slot (variant + sunk-auxiliary fallback chain). */
function shipIconUrlFor(ship: HoloShip): string | null {
  // Direction contract of the game's own HUD art: ally icons face LEFT,
  // enemy icons face RIGHT, and the sunk bitmap faces LEFT — so each side
  // has its OWN sunk variant ("sunk" for the ally row, the mirrored
  // "sunk-enemy" for the enemy row). Casualties never flip direction.
  const variant = ship.dead
    ? ship.role === "enemy"
      ? "sunk-enemy"
      : "sunk"
    : ship.role === "enemy"
      ? "enemy"
      : "ally";
  // Sunk auxiliaries have no sunk art — fall back to the same side's sunk
  // cruiser icon so a missing asset never blanks a slot in the strip.
  let url = holoShipIconUrl(ship.shipType, variant);
  if (!url && variant === "sunk") url = holoShipIconUrl("cruiser", "sunk");
  if (!url && variant === "sunk-enemy") url = holoShipIconUrl("cruiser", "sunk-enemy");
  return url;
}

/** One ship-icon slot. A real component (not a render-loop helper) so the
 *  useImage() hook is called per instance and tracks each slot's load state;
 *  a failed icon stays hidden instead of surfacing a broken-image glyph.
 *
 *  The slot also carries the damaged-only mini HP bar (like the in-game
 *  strip: nothing at full HP, a thin team-coloured bar once the hull is
 *  hurt) and forwards enter/leave to the caller's hover handlers — the
 *  app hangs its rich player tooltip off those. */
const ShipIcon = defineComponent({
  name: "HoloScorebarShipIcon",
  props: {
    ship: { type: Object as PropType<HoloShip>, required: true },
    onEnter: { type: Function as PropType<(ship: HoloShip, el: HTMLElement) => void>, default: null },
    onLeave: { type: Function as PropType<(ship: HoloShip) => void>, default: null },
  },
  setup(props) {
    const img = useImage(() => shipIconUrlFor(props.ship));
    return () => {
      const ship = props.ship;
      if (!img.src.value) return null;
      // Bar shows only while the hull is hurt (the game hides full and sunk
      // bars — sunk slots already read through the greyed icon).
      const hp = ship.hp;
      const maxHp = ship.maxHp;
      const hurt =
        !ship.dead &&
        hp != null &&
        maxHp != null &&
        maxHp > 0 &&
        hp < maxHp;
      const pct = hurt ? Math.max(0, Math.min(1, hp! / maxHp!)) : 0;
      const interactive = !!(props.onEnter || props.onLeave);
      return (
        <span
          class={["holo-scorebar__slot", interactive ? "is-interactive" : ""].join(" ")}
          onMouseenter={props.onEnter ? (e: MouseEvent) => props.onEnter!(ship, e.currentTarget as HTMLElement) : undefined}
          onMouseleave={props.onLeave ? () => props.onLeave!(ship) : undefined}
        >
          <img
            class={["holo-scorebar__ship", ship.dead ? "is-sunk" : ""].join(" ")}
            src={img.src.value}
            alt={ship.name ?? ship.shipType ?? ""}
            width="15"
            height="15"
            style={{ visibility: img.status.value === "loaded" ? "visible" : "hidden" }}
            onLoad={img.onLoad}
            onError={img.onError}
          />
          {hurt ? (
            <span
              class={`holo-scorebar__slot-hp holo-scorebar__slot-hp--${ship.role === "enemy" ? "enemy" : "ally"}`}
              aria-hidden="true"
              style={{ "--slot-hp-pct": `${Math.round(pct * 100)}%` } as Record<string, string>}
            />
          ) : null}
        </span>
      );
    };
  },
});

export default defineComponent({
  name: "HoloScorebar",
  props: {
    state: { type: Object as PropType<HoloHudState>, required: true },
    /** Hover plumbing for the caller's rich tooltip (enter carries the
     *  slot's anchor element; leave fires when the pointer quits it). */
    onShipEnter: { type: Function as PropType<(ship: HoloShip, el: HTMLElement) => void>, default: null },
    onShipLeave: { type: Function as PropType<(ship: HoloShip) => void>, default: null },
  },
  setup(props) {
    return () => {
      const s = props.state;
      // Team order is owned by the caller (the app mirrors icons by ship
      // size; the site sorts alive-first) — we only split by side. Keys use
      // the caller's stable slot key when present so the alive/sunk
      // reshuffle reuses DOM nodes instead of remounting icons.
      const allies = s.ships.filter((sh) => sh.role !== "enemy");
      const enemies = s.ships.filter((sh) => sh.role === "enemy");
      const enter = props.onShipEnter ?? undefined;
      const leave = props.onShipLeave ?? undefined;
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
              {allies.map((sh, i) => (
                <ShipIcon key={sh.key ?? `a${i}`} ship={sh} onEnter={enter} onLeave={leave} />
              ))}
              <span class="holo-scorebar__ships-sep" />
              {enemies.map((sh, i) => (
                <ShipIcon key={sh.key ?? `e${i}`} ship={sh} onEnter={enter} onLeave={leave} />
              ))}
            </span>
          ) : null}
        </div>
      );
    };
  },
});
