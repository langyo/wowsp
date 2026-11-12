/**
 * Squadron status panel — the chased formation's per-GROUP, per-PLANE HP
 * readout, docked directly above the recorder's hull plaque in the bottom-
 * left HUD block (same width contract as the plaque: --holo-hud-block-w).
 *
 * The layout mirrors the in-game squadron widget (user spec): the wing is
 * split into its flight GROUPS with a gap between them, and each group is
 * cut into one segment per plane. A segment recolours by that plane's E27
 * HP band (green → amber → red) and disappears when the plane is shot
 * down, so the whole wing's attrition reads at a glance instead of one
 * aggregate bar. Row two carries the engine state: the boost / slow /
 * consumable chips plus the thin boost gauge.
 */
import { defineComponent, type PropType } from "vue";
import { t as i18nT } from "@/i18n";
import type { PlaneSlotHealth } from "./planeFollow";
import "./HoloSquadronPanel.scss";

export interface HoloSquadronPanelState {
  /** Carrier nickname (the hull plaque's owner) — the panel's caption. */
  carrierName: string;
  shipName: string;
  /** One entry per FLIGHT GROUP, in slot order; each holds that group's
   *  planes as HP bands (1 = >3/4, 2 = (1/4, 3/4], 4 = <=1/4, 0/undefined =
   *  the slot no longer flies). Empty groups are dropped. */
  groups: PlaneSlotHealth[][];
  /** Planes still flying / launch strength (the caption's numbers). */
  alive: number;
  total: number;
  /** Engine state row: boost (throttle 1), slow (throttle −1) and the open
   *  consumable windows, plus the one-shot boost window fraction. */
  boost: boolean;
  slow: boolean;
  consumables: string[];
  /** Remaining fraction of the healForsage one-shot window (null = off). */
  forsage: number | null;
  /** False while the formation is on its way home / already recalled: the
   *  panel then shows the caption only (no HP segments — user request: a
   *  returning wing no longer carries a health readout). */
  combat: boolean;
}

/** One segment per plane: the band picks its colour, a dead/absent slot
 *  keeps its space so the group's silhouette stays stable (the in-game
 *  widget's behaviour). */
function segmentClass(band: number | null): string {
  if (band == null || band === 0) return "holo-squad__plane holo-squad__plane--dead";
  if (band === 1) return "holo-squad__plane holo-squad__plane--ok";
  if (band === 2) return "holo-squad__plane holo-squad__plane--hurt";
  return "holo-squad__plane holo-squad__plane--crit";
}

export default defineComponent({
  name: "HoloSquadronPanel",
  props: {
    state: { type: Object as PropType<HoloSquadronPanelState>, required: true },
  },
  setup(props) {
    return () => {
      const s = props.state;
      return (
        <div class="holo-squad">
          <div class="holo-squad__head">
            <span class="holo-squad__name">{s.carrierName}</span>
            <span class="holo-squad__ship">{s.shipName}</span>
            <span class="holo-squad__count">
              <b>{s.alive}</b>
              <i>/</i>
              <span>{s.total}</span>
            </span>
          </div>
          {s.combat ? (
            <div class="holo-squad__groups">
              {s.groups.map((group, gi) => (
                <span class="holo-squad__group" key={gi}>
                  {group.map((plane, pi) => (
                    <i class={segmentClass(plane.band)} key={pi} />
                  ))}
                </span>
              ))}
            </div>
          ) : (
            <div class="holo-squad__returning">{i18nT("replay.squadron.returning")}</div>
          )}
          <div class="holo-squad__engine">
            {s.boost ? (
              <span class="holo-squad__chip holo-squad__chip--boost">
                {i18nT("replay.planeCard.boost")}
              </span>
            ) : null}
            {s.slow ? (
              <span class="holo-squad__chip holo-squad__chip--slow">
                {i18nT("replay.planeCard.slow")}
              </span>
            ) : null}
            {s.consumables.slice(0, 3).map((label, i) => (
              <span class="holo-squad__chip" key={i}>{label}</span>
            ))}
            {s.forsage != null ? (
              <span class="holo-squad__gauge" aria-hidden="true">
                <i
                  class="holo-squad__gauge-fill"
                  style={{ width: `${Math.round(s.forsage * 100)}%` }}
                />
              </span>
            ) : null}
          </div>
        </div>
      );
    };
  },
});
