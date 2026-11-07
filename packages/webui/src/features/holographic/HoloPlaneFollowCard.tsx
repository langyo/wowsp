/**
 * Plane-follow pill card (bottom-left, beside the hull plaque): a compact
 * holographic readout for the carrier-aircraft chase camera. While follow
 * mode chases a carrier's AIRCRAFT it names the chased carrier (player
 * nickname + hull) and shows the squadron strength "alive / total", an
 * "attacking" badge while the formation is in an attack-run dive, or — when
 * nothing is airborne at the playhead — a muted "following hull" line (the
 * chase camera rides the carrier's hull fallback then).
 *
 * The E27 squadron-state extras ride the same snapshot: a compact HP bar
 * (the squadron's total 0..1 health fraction), an amber "boost" badge
 * while the engine boost is on, and up to three active-consumable chips
 * (used→stopWorking windows). All three are optional — a pre-E27 replay
 * (or a failed side-load) renders the pre-extras pill unchanged.
 *
 * Pure rendering over an explicit snapshot prop (HoloPlaneFollowState):
 * the parent derives it at the 10 Hz hudCurrent cadence from the same trail
 * tables the follow camera reads (planeFollow.ts) and hides the card
 * entirely whenever follow mode is not on a carrier aircraft. Chrome
 * matches the bottom-left cards (HoloSelfCard's plaque row); the styles
 * live in this component's own sheet so HolographicMap.scss stays put.
 */
import { defineComponent, type PropType } from "vue";
import { Plane } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import { consumableLabelKey } from "./planeFollow";
import "./HoloPlaneFollowCard.scss";

/** One snapshot of the chased carrier's air state. */
export interface HoloPlaneFollowState {
  /** Controlling player's nickname (the carrier label's name). */
  carrierName: string;
  /** Hull display name (the carrier label's shipName). */
  shipName: string;
  /** Planes still up / launch strength of the chased formation. */
  alive: number;
  total: number;
  /** True while any sampled plane is in an attack-run dive. */
  attacking: boolean;
  /** False → no squadron is airborne at the playhead; the camera is on the
   *  hull fallback and the card shows the muted hull line instead. */
  airborne: boolean;
  /** Squadron TOTAL-HP fraction (0..1, the E27 health stream) at the
   *  playhead; null / undefined hides the bar (no sample yet, pre-E27
   *  replay, or the hull fallback — optional so unwired parents keep
   *  compiling). */
  hp?: number | null;
  /** True while the last E27 throttle mode at the playhead is engine
   *  boost (mode 1). */
  boost?: boolean;
  /** Consumable type ids whose E27 effect window is open at the playhead;
   *  the card renders the first three as chips. */
  consumables?: number[];
}

/** Clamp the wire's 0..1 HP fraction defensively for bar geometry (a
 *  stray out-of-range sample must not stretch the bar past its track). */
function hpClamped(hp: number): number {
  return Math.min(1, Math.max(0, hp));
}

/** Local twin of @wowsp/holo HoloShipCard's healthColor ramp (module-
 *  private there, so not importable): green above 60%, amber above 30%,
 *  red below — thresholds read on the 0..1 fraction instead of percent. */
function hpBarColor(hp: number): string {
  if (hp > 0.6) return "#4ade80";
  if (hp > 0.3) return "#facc15";
  return "#f87171";
}

export default defineComponent({
  name: "HoloPlaneFollowCard",
  props: {
    /** Current snapshot; null renders nothing (the parent hides the card
     *  by not passing a snapshot at all). */
    state: { type: Object as PropType<HoloPlaneFollowState | null>, default: null },
  },
  setup(props) {
    return () => {
      const s = props.state;
      if (!s) return null;
      return (
        <div class="holo-planecard">
          <Plane size={14} class="holo-planecard__ico" />
          <span class="holo-planecard__who">
            <span class="holo-planecard__player">{s.carrierName}</span>
            <span class="holo-planecard__ship">{s.shipName}</span>
          </span>
          {s.airborne ? (
            <>
              {s.hp != null ? (
                <span
                  class="holo-planecard__hp"
                  data-hint={`${Math.round(hpClamped(s.hp) * 100)}%`}
                >
                  <i
                    class="holo-planecard__hpfill"
                    style={{
                      width: `${Math.round(hpClamped(s.hp) * 100)}%`,
                      backgroundColor: hpBarColor(s.hp),
                    }}
                  />
                </span>
              ) : null}
              <span class="holo-planecard__strength">
                <b class="holo-planecard__num">{s.alive}</b>
                <span class="holo-planecard__slash">/</span>
                <span class="holo-planecard__num holo-planecard__num--dim">{s.total}</span>
                {s.attacking ? (
                  <span class="holo-planecard__badge">{i18nT("replay.planeCard.attacking")}</span>
                ) : null}
                {s.boost ? (
                  <span class="holo-planecard__badge holo-planecard__badge--boost">
                    {i18nT("replay.planeCard.boost")}
                  </span>
                ) : null}
              </span>
              {(s.consumables ?? []).slice(0, 3).map((consumableType) => (
                <span key={consumableType} class="holo-planecard__chip">
                  {i18nT(consumableLabelKey(consumableType))}
                </span>
              ))}
            </>
          ) : (
            <span class="holo-planecard__hull">{i18nT("replay.planeCard.followingHull")}</span>
          )}
        </div>
      );
    };
  },
});
