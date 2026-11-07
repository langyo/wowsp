/**
 * Recorder ship health plaque (shared HoloShipCard) plus the self battle
 * stats strip beside it, extracted verbatim from HolographicMap.tsx as a
 * self-contained leaf component. The parent owns the derived data (card +
 * live stats + depth) and the visibility conditions; this only renders
 * them. A submerged recorder submarine additionally shows a compact depth
 * pill between plaque and stats strip (see the depth prop).
 */
import { defineComponent, type PropType } from "vue";
import { ArrowDownFromLine, Crosshair, Shield, Skull, Swords } from "@lucide/vue";
import { HoloShipCard, type HoloShipCardData } from "@wowsp/holo";
import { t as i18nT } from "@/i18n";
import "./HoloSelfCard.scss";

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
    /** Recorder submarine depth: positive rounded meters below the surface
     *  (parent mirrors ShipLabel.depthMeters into this shape per playhead
     *  tick). null = surface ship / not a submarine — no badge renders. */
    depth: { type: Object as PropType<{ meters: number } | null>, default: null },
  },
  setup(props) {
    return () => (
      <div class="holo-map__shipcard">
        {/* deadText: the localized 已击沉 label replaces the HP numbers once
            the ship sinks — the plaque's fixed readout slot keeps the row
            width stable across the flip. */}
        <HoloShipCard data={props.card} deadText={i18nT("replay.shipSunk")} />
        {/* Submerged recorder submarine: compact depth pill between the
            plaque and the stats strip (icon pattern matches the stat
            icons; styling lives in HoloSelfCard.scss — the shared HUD
            tokens keep it on-theme in both modes). */}
        {props.depth ? (
          <span class="holo-map__depthbadge">
            <ArrowDownFromLine size={14} class="holo-map__depthbadge-ico" />
            <b class="holo-map__depthbadge-num">
              {i18nT("replay.selfDepth", { meters: props.depth.meters })}
            </b>
          </span>
        ) : null}
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
