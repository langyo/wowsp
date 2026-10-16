/**
 * HoloShipStatus — the below-hull combat status rows for the holographic
 * map, shown per ship while the camera is close enough (chase view):
 *   row 1 — what the ship DOES: gun/torpedo launch flashes with their
 *           reload countdown bars, smoke and repair windows (LoL-style
 *           icon tiles with a draining progress bar + seconds).
 *   row 2 — what it SUFFERS: shell / torpedo hit pills with the damage
 *           they took, plus persistent fire / flooding chips counting
 *           down from their class base duration.
 * Icons are the game's own HUD art (see statusIcons.ts): the gun tile
 * carries the salvo's shell sprite, smoke/repair the consumable slot art,
 * fire/flood the state-panel glyphs, hits the ammo/torpedo sprites.
 * Every countdown renders BELOW its icon (fixed row height — only the
 * damage pills read horizontally); sub-10-second counts show one decimal.
 * Data comes precomputed per playhead tick via ShipLabel.status; this
 * component is pure rendering + styling.
 */
import { defineComponent, type PropType } from "vue";
import type { ShipActionChip, ShipHitChip, ShipDotChip } from "./shipStatusModel";
import {
  actionIconUrl,
  dotIconUrl,
  torpedoIconUrl,
  AMMO_ICON,
} from "./statusIcons";
import type { ShipLabel } from "./shipLabel";
import "./HoloShipStatus.scss";

/** Countdown text: whole seconds above ten, one decimal below — the last
 *  ten seconds of a reload or burn deserve the extra resolution. The
 *  threshold sits at 9.95 so rounding never prints "10.0" below "10". */
export function fmtSecs(v: number): string {
  return v < 9.95 ? v.toFixed(1) : String(Math.ceil(v));
}

export default defineComponent({
  name: "HoloShipStatus",
  props: {
    label: { type: Object as PropType<ShipLabel>, required: true },
  },
  setup(props) {
    return () => {
      const l = props.label;
      const st = l.status;
      if (!l.belowVisible || !st) return null;
      return (
        <div
          class="holo-ship-status"
          style={{ left: `${l.belowX}px`, top: `${l.belowY}px` }}
        >
          {st.actions.length > 0 ? (
            <div class="holo-ship-status__row">
              {st.actions.map((a) => (
                <ActionChip key={a.key} chip={a} />
              ))}
            </div>
          ) : null}
          {st.hits.length > 0 || st.dots.length > 0 ? (
            <div class="holo-ship-status__row">
              {st.dots.map((d) => (
                <DotChip key={d.key} chip={d} />
              ))}
              {st.hits.map((h) => (
                <HitChip key={h.key} chip={h} />
              ))}
            </div>
          ) : null}
        </div>
      );
    };
  },
});

function ActionChip({ chip }: { chip: ShipActionChip }) {
  return (
    <span
      class={[
        "holo-ship-status__chip",
        `is-${chip.key}`,
        `is-${chip.phase}`,
      ]}
    >
      <span class="holo-ship-status__icon">
        <img
          class="holo-ship-status__img"
          src={actionIconUrl(chip.key, chip.ammo)}
          alt=""
          draggable={false}
        />
        <span
          class="holo-ship-status__bar"
          style={{ width: `${Math.round(chip.frac * 100)}%` }}
        />
      </span>
      {/* The seconds line is always mounted (blank during a flash) so the
          tile keeps a fixed height and the row never jumps. */}
      <span class="holo-ship-status__secs">
        {chip.phase !== "flash" && chip.secs != null ? fmtSecs(chip.secs) : ""}
      </span>
    </span>
  );
}

function DotChip({ chip }: { chip: ShipDotChip }) {
  return (
    <span class={["holo-ship-status__chip", `is-${chip.key}`]}>
      <span class="holo-ship-status__icon">
        <img
          class="holo-ship-status__img"
          src={dotIconUrl(chip.key)}
          alt=""
          draggable={false}
        />
        <span
          class="holo-ship-status__bar"
          style={{ width: `${Math.round(chip.frac * 100)}%` }}
        />
      </span>
      <span class="holo-ship-status__secs">{fmtSecs(chip.secs)}</span>
    </span>
  );
}

function HitChip({ chip }: { chip: ShipHitChip }) {
  // Torpedo hits show the torpedo sprite; shell hits the ammo family's
  // sprite; unresolvable params ids fall back to the bare damage number.
  const src =
    chip.kind === "torpedo"
      ? torpedoIconUrl
      : chip.ammo != null
        ? AMMO_ICON[chip.ammo]
        : undefined;
  return (
    <span
      class={[
        "holo-ship-status__hit",
        chip.kind === "torpedo" ? "is-torpedo" : "",
      ]}
    >
      {src ? (
        <img class="holo-ship-status__hit-img" src={src} alt="" draggable={false} />
      ) : null}
      <span class="holo-ship-status__dmg">-{chip.dmg.toLocaleString()}</span>
    </span>
  );
}
