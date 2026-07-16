import { defineComponent, computed, ref, type PropType } from "vue";

import { t } from "@/i18n";
import {
  readArmorDict,
  armorHistogram,
  zoneArmor,
  armorColor,
  ARMOR_BUCKETS,
  overmatchThreshold,
  canOvermatch,
  apOutcome,
  type ZoneArmor,
} from "./ballistics";
import "./ArmorBelt.scss";

/**
 * Armor zone viewer for the detail modal's Armor tab.
 *
 * Because the baked ship GLBs are merged meshes with no per-part armor groups
 * (the armor group ids live in the .geometry file we don't ship), we can't
 * color the 3D model by zone. Instead we render a schematic **side-profile
 * armor belt diagram**: a generic ship silhouette split into named zones
 * (bow / midship / citadel / stern + belt + deck), each coloured by its
 * representative thickness, with a hover tooltip showing:
 *
 *   - the thickness in mm
 *   - the smallest caliber that overmatches it (armor × 14.3)
 *   - how common BB calibers (356/380/406/420/460 mm) interact with it
 *     (overmatch / pen / overpen), per the WoWS 14.3 rule
 *
 * Thickness assignment is a heuristic (sorted by thickness, thickest →
 * citadel, then belt/deck, thinnest → bow/stern) since we lack the spatial
 * group→zone mapping. Zones are flagged 「估算」 (estimated).
 */

type Gp = Record<string, any> | null | undefined;

/** Common BB calibers to show in the overmatch breakdown (mm). */
const REFERENCE_CALIBERS = [356, 380, 406, 420, 457, 460];

export default defineComponent({
  name: "ArmorBelt",
  props: {
    gameparams: { type: Object as PropType<Gp>, default: null },
  },
  setup(props) {
    const dict = computed(() => readArmorDict(props.gameparams));
    const zones = computed<ZoneArmor[]>(() => zoneArmor(dict.value));
    const buckets = computed(() => armorHistogram(dict.value));
    /** Hovered zone for the tooltip. */
    const hovered = ref<ZoneArmor | null>(null);
    const tooltipPos = ref({ x: 0, y: 0 });

    /** Build the overmatch breakdown for a thickness. */
    function overmatchInfo(thickness: number | null) {
      if (thickness == null || thickness <= 0) return null;
      const threshold = overmatchThreshold(thickness);
      const rows = REFERENCE_CALIBERS.map((cal) => ({
        caliber: cal,
        outcome: apOutcome(cal, thickness),
        overmatch: canOvermatch(cal, thickness),
      }));
      return { threshold, rows };
    }

    function onZoneEnter(e: MouseEvent, z: ZoneArmor) {
      hovered.value = z;
      const target = e.currentTarget as HTMLElement;
      const r = target.getBoundingClientRect();
      tooltipPos.value = { x: r.left + r.width / 2, y: r.top };
    }
    function onZoneLeave() {
      hovered.value = null;
    }

    /** SVG geometry for the schematic silhouette. Coordinates in a 800×220 viewBox. */
    // Hull profile points (generic destroyer-to-battleship silhouette, bow right).
    const HULL_PATH =
      "M 60 150 L 120 120 L 280 110 L 520 108 L 680 112 L 740 130 L 740 150 L 700 168 L 200 170 L 80 168 Z";
    // Zone x-spans (bow/stern/midship/citadel) along the hull length.
    const ZONE_SPANS = [
      { zone: "stern" as const, x: 60, w: 120 },
      { zone: "midship" as const, x: 180, w: 160 },
      { zone: "citadel" as const, x: 340, w: 200 },
      { zone: "midship" as const, x: 540, w: 100 },
      { zone: "bow" as const, x: 640, w: 100 },
    ];

    function zoneThickness(name: ZoneArmor["zone"]): number | null {
      const z = zones.value.find((x) => x.zone === name);
      return z?.thickness ?? null;
    }

    return () => {
      if (!dict.value) {
        return <div class="armor-belt armor-belt--empty">{t("ships.detail.armor.noData")}</div>;
      }
      return (
        <div class="armor-belt">
          <div class="armor-belt__diagram">
            <svg viewBox="0 0 800 220" class="armor-belt__svg" preserveAspectRatio="xMidYMid meet">
              {/* waterline */}
              <line x1="0" y1="170" x2="800" y2="170" class="armor-belt__waterline" />
              {/* hull silhouette base */}
              <path d={HULL_PATH} class="armor-belt__hull" />
              {/* zone color bands (superstructure body) */}
              {ZONE_SPANS.map((sp, i) => {
                const th = zoneThickness(sp.zone);
                const color = armorColor(th);
                return (
                  <rect
                    key={i}
                    x={sp.x}
                    y={108}
                    width={sp.w}
                    height={62}
                    fill={color}
                    fillOpacity={0.78}
                    class="armor-belt__zone"
                    onMouseenter={(e) => onZoneEnter(e, { zone: sp.zone, thickness: th, estimated: true })}
                    onMouseleave={onZoneLeave}
                  />
                );
              })}
              {/* belt — a thick horizontal strip at the waterline */}
              <rect
                x={120}
                y={150}
                width={560}
                height={14}
                fill={armorColor(zoneThickness("belt"))}
                fillOpacity={0.85}
                class="armor-belt__zone"
                onMouseenter={(e) => onZoneEnter(e, { zone: "belt", thickness: zoneThickness("belt"), estimated: true })}
                onMouseleave={onZoneLeave}
              />
              {/* deck — top strip */}
              <rect
                x={140}
                y={104}
                width={540}
                height={8}
                fill={armorColor(zoneThickness("deck"))}
                fillOpacity={0.85}
                class="armor-belt__zone"
                onMouseenter={(e) => onZoneEnter(e, { zone: "deck", thickness: zoneThickness("deck"), estimated: true })}
                onMouseleave={onZoneLeave}
              />
              {/* hull outline on top */}
              <path d={HULL_PATH} class="armor-belt__outline" fill="none" />
              {/* zone labels */}
              {ZONE_SPANS.filter((sp, i) => ZONE_SPANS.findIndex((s) => s.zone === sp.zone) === i).map((sp) => {
                const th = zoneThickness(sp.zone);
                return (
                  <text
                    x={sp.x + sp.w / 2}
                    y={200}
                    class="armor-belt__zone-label"
                    text-anchor="middle"
                  >
                    {t(`ships.detail.armor.zone.${sp.zone}`)}{th != null ? ` ${th}mm` : ""}
                  </text>
                );
              })}
            </svg>
            <span class="armor-belt__estimate">{t("ships.detail.armor.estimated")}</span>
          </div>

          {/* legend */}
          <div class="armor-belt__legend">
            <span class="armor-belt__legend-title">{t("ships.detail.armor.legend")}</span>
            {ARMOR_BUCKETS.map((b) => (
              <span class="armor-belt__legend-item" key={b.label}>
                <span class="armor-belt__swatch" style={{ background: b.color }} />
                <span class="armor-belt__legend-range">{b.label}mm</span>
                <span class="armor-belt__legend-count">
                  {buckets.value.find((bk) => bk.label === b.label)?.count ?? 0}
                </span>
              </span>
            ))}
          </div>

          {/* hover tooltip */}
          {hovered.value ? (
            <div
              class="armor-belt__tooltip"
              style={{ left: `${tooltipPos.value.x}px`, top: `${tooltipPos.value.y}px` }}
            >
              {(() => {
                const z = hovered.value!;
                const th = z.thickness;
                const info = overmatchInfo(th);
                return (
                  <>
                    <div class="armor-belt__tip-head">
                      <span class="armor-belt__tip-swatch" style={{ background: armorColor(th) }} />
                      <strong>{t(`ships.detail.armor.zone.${z.zone}`)}</strong>
                      <span>{th != null ? `${th}mm` : "—"}</span>
                    </div>
                    {info ? (
                      <div class="armor-belt__tip-body">
                        <div class="armor-belt__tip-line">
                          {t("ships.detail.armor.overmatchThreshold", { n: info.threshold })}
                        </div>
                        <table class="armor-belt__tip-table">
                          <tbody>
                            {info.rows.map((r) => (
                              <tr key={r.caliber}>
                                <td>{r.caliber}mm</td>
                                <td>
                                  <span class={`armor-belt__outcome armor-belt__outcome--${r.outcome}`}>
                                    {t(`ships.detail.armor.outcome.${r.outcome}`)}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          ) : null}
        </div>
      );
    };
  },
});
