/**
 * Top-right weather-restriction badge of the holographic map — the replay's
 * take on the in-game cyclone banner. Shows the announced weather while it
 * approaches (with countdown), the live spotting cap while it ramps in,
 * holds while active, and fades as it lifts. Pure rendering over an
 * explicit props snapshot (weatherStateAt at the playhead); the timeline
 * math lives in weather.ts.
 */
import { defineComponent, type PropType } from "vue";
import { Cloud, CloudLightning, CloudRain, CloudSnow } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import { M_PER_WORLD_UNIT, weatherVisKm, type WeatherView } from "./weather";
import { ringLabelKm } from "./rangeRings";

function mmss(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default defineComponent({
  name: "HoloWeatherBadge",
  props: {
    /** Weather state at the playhead (null = clear, render nothing). */
    view: { type: Object as PropType<WeatherView | null>, default: null },
  },
  setup(props) {
    return () => {
      const v = props.view;
      if (!v) return null;
      // While a storm clears the badge keeps naming the storm that is
      // leaving, not the calm it returns to.
      const namedKind = v.phase === "clearing" ? v.fromKind : v.kind;
      const kindKey = `replay.weather.kind.${namedKind}`;
      const kindLabel = i18nT(kindKey);
      const title = kindKey === kindLabel ? i18nT("replay.weather.kind.other") : kindLabel;
      const Icon =
        namedKind === "cyclone"
          ? CloudLightning
          : namedKind === "snowstorm"
            ? CloudSnow
            : namedKind === "calm" || namedKind === "other"
              ? Cloud
              : CloudRain;
      // Meta line: countdown while incoming, live/target spotting cap
      // otherwise (the in-game HUD's "visibility" readout).
      let meta = "";
      if (v.phase === "incoming" && v.etaSeconds != null) {
        meta = i18nT("replay.weather.incomingIn", { s: mmss(v.etaSeconds) });
        if (v.restrictive && v.targetVisUnits != null) {
          meta += ` · ${i18nT("replay.weather.visibility")} ${ringLabelKm(v.targetVisUnits * M_PER_WORLD_UNIT)} km`;
        }
      } else {
        const km = weatherVisKm(v);
        if (km != null) {
          meta = `${i18nT("replay.weather.visibility")} ${km.toFixed(1).replace(/\.0$/, "")} km`;
        }
      }
      return (
        <div class={["holo-map__weather", `holo-map__weather--${v.phase}`]} aria-live="off">
          <span class="holo-map__weather-ico">
            <Icon size={15} />
          </span>
          <span class="holo-map__weather-body">
            <span class="holo-map__weather-title">
              {title}
              <span class="holo-map__weather-phase">
                {i18nT(`replay.weather.phase.${v.phase}`)}
              </span>
            </span>
            {meta ? <span class="holo-map__weather-meta">{meta}</span> : null}
          </span>
        </div>
      );
    };
  },
});
