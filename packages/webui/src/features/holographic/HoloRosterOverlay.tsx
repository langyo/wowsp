/**
 * Tab-held roster overlay of the holographic map (allies / enemies tables
 * read straight off the replay header's vehicle list), extracted verbatim
 * from HolographicMap.tsx as a self-contained leaf component.
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
  },
  setup(props) {
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
                <td>{v.shipName ?? shipNameFromOfflineDb(v.shipId, useLanguage().dataLanguage.value) ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
                <td></td>
              </tr>
            ))}
          </tbody>
          <thead>
            <tr><th colspan="3">{i18nT("replay.roster.enemies")}</th></tr>
          </thead>
          <tbody>
            {props.vehicles.filter(v => v.relation > 1).map(v => (
              <tr key={v.id}>
                <td style={{color: "#cc3333"}}>{v.name}</td>
                <td>{v.shipName ?? shipNameFromOfflineDb(v.shipId, useLanguage().dataLanguage.value) ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});
