/**
 * Recorder ship health plaque (shared HoloShipCard) plus the self battle
 * stats strip beside it, extracted verbatim from HolographicMap.tsx as a
 * self-contained leaf component. The parent owns the derived data (card +
 * live stats) and the visibility conditions; this only renders them.
 */
import { defineComponent, type PropType } from "vue";
import { Crosshair, Shield, Skull, Swords } from "@lucide/vue";
import { HoloShipCard, type HoloShipCardData } from "@wowsp/holo";
import { t as i18nT } from "@/i18n";

/** Live self statistics under the plaque (hits / frags / damage / taken). */
export interface HoloSelfStats {
  hits: number;
  damage: number;
  frags: number;
  taken: number;
  planeDamage: number;
}

export default defineComponent({
  name: "HoloSelfCard",
  props: {
    card: { type: Object as PropType<HoloShipCardData>, required: true },
    stats: { type: Object as PropType<HoloSelfStats | null>, default: null },
  },
  setup(props) {
    return () => (
      <div class="holo-map__shipcard">
        <HoloShipCard data={props.card} />
        {/* Self battle stats ride to the right of the hull plaque:
            icon + short label + number per stat, bottom-aligned with
            the plaque, content centred inside. Exactly four segments
            at a nominal 4.5rem each (compressed only when the map is
            too narrow for the row) — no conditional fifth (plane)
            stat: its appearance resized the strip past the viewport
            edge. */}
        {props.stats ? (
          <div class="holo-map__selfstats">
            <span class="holo-map__selfstat">
              <Crosshair size={14} class="holo-map__selfstat-ico" />
              <i class="holo-map__selfstat-label">{i18nT("replay.selfHits")}</i>
              <b class="holo-map__selfstat-num">{props.stats.hits}</b>
            </span>
            <span class="holo-map__selfstat">
              <Skull size={14} class="holo-map__selfstat-ico" />
              <i class="holo-map__selfstat-label">{i18nT("replay.selfFrags")}</i>
              <b class="holo-map__selfstat-num">{props.stats.frags}</b>
            </span>
            <span class="holo-map__selfstat">
              <Swords size={14} class="holo-map__selfstat-ico" />
              <i class="holo-map__selfstat-label">{i18nT("replay.selfDamage")}</i>
              <b class="holo-map__selfstat-num">{props.stats.damage.toLocaleString()}</b>
            </span>
            <span class="holo-map__selfstat">
              <Shield size={14} class="holo-map__selfstat-ico" />
              <i class="holo-map__selfstat-label">{i18nT("replay.selfTaken")}</i>
              <b class="holo-map__selfstat-num">{props.stats.taken.toLocaleString()}</b>
            </span>
          </div>
        ) : null}
      </div>
    );
  },
});
