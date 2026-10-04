/**
 * HoloShipStatus — the below-hull combat status rows for the holographic
 * map, shown per ship while the camera is close enough (chase view):
 *   row 1 — what the ship DOES: gun/torpedo launch flashes with their
 *           reload countdown bars, smoke and repair windows (LoL-style
 *           icon tiles with a draining progress bar + seconds).
 *   row 2 — what it SUFFERS: shell / torpedo hit pills with the damage
 *           they took, plus persistent fire / flooding chips counting
 *           down from their class base duration.
 * Every countdown renders BELOW its icon (fixed row height — only the
 * damage pills read horizontally); sub-10-second counts show one decimal.
 * Data comes precomputed per playhead tick via ShipLabel.status; this
 * component is pure rendering + styling.
 */
import { defineComponent, type PropType } from "vue";
import {
  CloudFog,
  Crosshair,
  Droplets,
  Flame,
  Navigation,
  Wrench,
} from "@lucide/vue";
import type { ShipActionChip, ShipHitChip, ShipDotChip } from "./shipStatusModel";
import type { ShipLabel } from "./shipLabel";
import "./HoloShipStatus.scss";

const ACTION_ICON = {
  gun: Crosshair,
  torp: Navigation,
  smoke: CloudFog,
  repair: Wrench,
} as const;

/** Shell ammo families render as tinted text badges — same palette as the
 *  shell-flight traces (SHELL_COLORS), so a pill matches the arc that
 *  delivered it. */
const AMMO_TEXT: Record<string, string> = {
  HE: "HE",
  AP: "AP",
  SAP: "SAP",
  CS: "CS",
};

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
  const Icon = ACTION_ICON[chip.key];
  return (
    <span
      class={[
        "holo-ship-status__chip",
        `is-${chip.key}`,
        `is-${chip.phase}`,
      ]}
    >
      <span class="holo-ship-status__icon">
        <Icon size={11} strokeWidth={2.4} />
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
  const Icon = chip.key === "fire" ? Flame : Droplets;
  return (
    <span class={["holo-ship-status__chip", `is-${chip.key}`]}>
      <span class="holo-ship-status__icon">
        <Icon size={11} strokeWidth={2.4} />
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
  // Torpedoes get the fish glyph; shells get a tinted ammo badge — except
  // unresolvable params ids, which fall back to the bare damage number.
  const ammo = chip.kind === "shell" ? chip.ammo : null;
  return (
    <span
      class={[
        "holo-ship-status__hit",
        chip.kind === "torpedo" ? "is-torpedo" : "",
      ]}
    >
      {chip.kind === "torpedo" ? (
        <span class="holo-ship-status__ammo is-torpedo-icon">
          <Navigation size={9} strokeWidth={2.6} />
        </span>
      ) : ammo && AMMO_TEXT[ammo] ? (
        <span class={`holo-ship-status__ammo is-${ammo}`}>
          {AMMO_TEXT[ammo]}
        </span>
      ) : null}
      <span class="holo-ship-status__dmg">-{chip.dmg.toLocaleString()}</span>
    </span>
  );
}
