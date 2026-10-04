/**
 * Tab-held roster overlay of the holographic map (allies / enemies tables
 * read straight off the replay header's vehicle list), extracted verbatim
 * from HolographicMap.tsx as a self-contained leaf component. Operation
 * scenarios (行动) render a single allies table — their relation values
 * carry real side semantics (allied escort waves ≤ 1, enemy warships > 1),
 * so the allies rows keep the relation split while the enemy table stays
 * hidden.
 */
import { defineComponent, type PropType } from "vue";
import { t as i18nT } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { shipNameFromModelDb, shipNameFromOfflineDb } from "./modelLoader";
import type { VehicleEntry } from "@/api";

export default defineComponent({
  name: "HoloRosterOverlay",
  props: {
    vehicles: { type: Array as PropType<VehicleEntry[]>, required: true },
    /** Operation scenario (行动): single allies table, no enemy one. */
    operation: { type: Boolean, default: false },
  },
  setup(props) {
    const shipNameOf = (v: VehicleEntry) =>
      v.shipName
        ?? shipNameFromOfflineDb(v.shipId, useLanguage().dataLanguage.value)
        ?? shipNameFromModelDb(v.shipId)
        ?? "";
    return () => (
      <div class="holo-map__roster-overlay">
        <table>
          <thead>
            <tr><th colspan="3">{i18nT("replay.roster.allies")}</th></tr>
          </thead>
          <tbody>
            {props.vehicles.filter(v => v.relation <= 1).map(v => (
              <tr key={v.id}>
                <td style={{color: v.relation === 0 ? "#fff" : "#3cb478"}}>{v.name}</td>
                <td>{shipNameOf(v)}</td>
                <td></td>
              </tr>
            ))}
          </tbody>
          {!props.operation ? (
            <>
              <thead>
                <tr><th colspan="3">{i18nT("replay.roster.enemies")}</th></tr>
              </thead>
              <tbody>
                {props.vehicles.filter(v => v.relation > 1).map(v => (
                  <tr key={v.id}>
                    <td style={{color: "#cc3333"}}>{v.name}</td>
                    <td>{shipNameOf(v)}</td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
            </>
          ) : null}
        </table>
      </div>
    );
  },
});
