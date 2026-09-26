/**
 * Camera-mode dropdown of the holographic map (free orbit / recorder camera /
 * follow-a-ship), extracted verbatim from HolographicMap.tsx as a
 * self-contained leaf component. Pure rendering over an explicit props
 * snapshot; the mode/menu state and the follow-camera logic stay in
 * HolographicMap and come back through the on* callbacks.
 */
import { defineComponent, type PropType } from "vue";
import { Crosshair, Orbit, Video } from "@lucide/vue";
import BattleIcon from "@/components/base/BattleIcon";
import { t as i18nT } from "@/i18n";
import { tierToRoman } from "@wowsp/holo";
import { shipTypeClass } from "./shipIcons";
import type { ShipLabel } from "./shipLabel";

export interface CameraShipGroup {
  key: string;
  title: string;
  items: ShipLabel[];
}

export default defineComponent({
  name: "HoloCameraMenu",
  props: {
    /** Current camera mode ("free" / "original" / "follow"). */
    mode: { type: String as PropType<"free" | "original" | "follow">, required: true },
    /** Dropdown open state. */
    open: { type: Boolean, required: true },
    /** Whether the replay carries recorder camera frames (Camera 0x25). */
    hasOriginalFrames: { type: Boolean, required: true },
    /** Follow-menu roster grouped by allegiance (self / allies / enemies). */
    groups: { type: Array as PropType<CameraShipGroup[]>, required: true },
    /** Per-entity "WR% · battles" readouts, resolved lazily by the parent. */
    followStats: { type: Map as PropType<Map<number, string>>, required: true },
    /** Currently followed entity id (null = free orbit). */
    selectedId: { type: Number as PropType<number | null>, required: true },
    onToggleMenu: { type: Function as PropType<() => void>, required: true },
    onPickMode: {
      type: Function as PropType<(mode: "free" | "original") => void>,
      required: true,
    },
    onPickShip: {
      type: Function as PropType<(entityId: number) => void>,
      required: true,
    },
  },
  setup(props) {
    return () => (
      <div class="holo-map__camera">
        <button
          class={["holo-map__lbltoggle", props.open ? "holo-map__lbltoggle--on" : ""]}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleMenu();
          }}
          data-hint={i18nT("replay.camera.title")}
          aria-label={i18nT("replay.camera.title")}
        >
          {props.mode === "original" ? (
            <Video size={14} />
          ) : props.mode === "follow" ? (
            <Crosshair size={14} />
          ) : (
            <Orbit size={14} />
          )}
        </button>
        {props.open ? (
          <div class="holo-map__cam-menu" onClick={(e) => e.stopPropagation()}>
            <div class="holo-map__cam-modes">
              <button
                class={["holo-map__cam-mode", props.mode === "free" ? "holo-map__cam-mode--on" : ""]}
                onClick={() => props.onPickMode("free")}
              >
                {i18nT("replay.camera.free")}
              </button>
              {props.hasOriginalFrames ? (
                <button
                  class={["holo-map__cam-mode", props.mode === "original" ? "holo-map__cam-mode--on" : ""]}
                  onClick={() => props.onPickMode("original")}
                >
                  {i18nT("replay.camera.original")}
                </button>
              ) : null}
            </div>
            {props.groups.map((g) => (
              <div key={g.key} class="holo-map__cam-group">
                <div class="holo-map__cam-group-title">{g.title}</div>
                {g.items.map((item) => (
                  <button
                    key={item.entityId}
                    class={[
                      "holo-map__cam-item",
                      item.entityId === props.selectedId ? "holo-map__cam-item--on" : "",
                      item.dead ? "holo-map__cam-item--dead" : "",
                    ]}
                    onClick={() => props.onPickShip(item.entityId)}
                  >
                    <span class="holo-map__cam-ico">
                      {item.type ? (
                        <BattleIcon
                          kind="ship"
                          type={item.type}
                          variant={item.role === "enemy" ? "enemy" : "ally"}
                          size={13}
                        />
                      ) : null}
                    </span>
                    <span class="holo-map__cam-body">
                      <span class="holo-map__cam-ship">{item.shipName}</span>
                      <span class="holo-map__cam-meta">
                        {item.tier ? tierToRoman(item.tier) : ""}
                        {item.type ? ` ${i18nT(`replay.classes.${shipTypeClass(item.type)}`)}` : ""}
                        {item.maxHp != null ? ` · ${item.maxHp.toLocaleString()} HP` : ""}
                      </span>
                    </span>
                    <span class="holo-map__cam-name">{item.name}</span>
                    <span class="holo-map__cam-stats">
                      {props.followStats.get(item.entityId) ?? "…"}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
});
