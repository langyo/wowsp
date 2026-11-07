/**
 * Camera-mode dropdown of the holographic map (free orbit / recorder camera /
 * follow-a-ship), extracted verbatim from HolographicMap.tsx as a
 * self-contained leaf component. Pure rendering over an explicit props
 * snapshot; the mode/menu state and the follow-camera logic stay in
 * HolographicMap and come back through the on* callbacks.
 *
 * Besides the ship roster, the menu hosts the carriers' air groups
 * (`kind: "plane"` rows): an aircraft carries no tier/class/HP readout, so
 * its row keeps the plane glyph, the carrier label and the group name, and
 * follows the plane through the same onPickShip callback. The
 * recorder-camera caption (what camera the replay itself was captured with)
 * and the jump-to-nearest-aircraft shortcut are the two replay-camera aids
 * that ride along with the aircraft follow mode.
 */
import { defineComponent, ref, type PropType } from "vue";
import { Crosshair, Orbit, Plane, Video } from "@lucide/vue";
import { HkPopover, HkScrollContainer } from "@celestia-island/hikari";
import BattleIcon from "@/components/base/BattleIcon";
import { t as i18nT } from "@/i18n";
import { tierToRoman } from "@wowsp/holo";
import type { RecordedCameraMode } from "./cameraModes";
import { shipTypeClass } from "./shipIcons";
import type { ShipLabel } from "./shipLabel";

export interface CameraShipGroup {
  key: string;
  title: string;
  items: ShipLabel[];
}

/** Locale keys for the recorder's camera modes (Camera 0x25 frames). The
 *  wire names are the replay decoder's; anything outside this table — a mode
 *  a future client build adds — reads as the generic "other view". */
const RECORDED_MODE_KEYS: Partial<Record<RecordedCameraMode, string>> = {
  airplanes: "replay.camera.mode.airplanes",
  followingPlanes: "replay.camera.mode.followingPlanes",
  followingShip: "replay.camera.mode.followingShip",
  followingShells: "replay.camera.mode.followingShells",
  freeFlying: "replay.camera.mode.freeFlying",
  overheadMap: "replay.camera.mode.overheadMap",
};

/** Localized name of a recorded-camera mode, "other view" for unknown ones. */
function recordedModeLabel(mode: RecordedCameraMode): string {
  return i18nT(RECORDED_MODE_KEYS[mode] ?? "replay.camera.mode.other");
}

/** Row hit-test selector suffix for aircraft rows (also the SCSS hook). */
const PLANE_ROW_CLASS = "holo-map__cam-item--plane";

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
    /** Currently followed entity id (null = free orbit). Vue's Number type
     *  check rejects null, so the nullable shape is a defaulted prop, not a
     *  required one — the parent always passes it either way. */
    selectedId: { type: Number as PropType<number | null>, default: null },
    /** Camera mode the REPLAY itself was captured with (Camera 0x25), or
     *  null when the replay carries no recorder-camera windows. Only
     *  non-null while the "original" mode is active, so the caption always
     *  annotates the recorder view it describes. */
    recordedMode: { type: String as PropType<RecordedCameraMode | null>, default: null },
    /** Whether the replay has a camera window following planes (drives the
     *  jump-to-aircraft shortcut). */
    hasPlaneCameraWindow: { type: Boolean, default: false },
    onToggleMenu: { type: Function as PropType<() => void>, required: true },
    onPickMode: {
      type: Function as PropType<(mode: "free" | "original") => void>,
      required: true,
    },
    onPickShip: {
      type: Function as PropType<(entityId: number) => void>,
      required: true,
    },
    /** Jump the playhead to the nearest camera window following aircraft. */
    onJumpPlaneCamera: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    // Anchor for the popover: the wrapper around the trigger button.
    const triggerWrap = ref<HTMLSpanElement | null>(null);

    /** One followable ship row: tier · class · HP and the WR stats readout. */
    const renderShipRow = (item: ShipLabel) => (
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
            {/* The label keys off shipTypeClass's atlas class —
                an unknown type has none, and a missing label
                beats interpolating the bare i18n key path. */}
            {(() => {
              const cls = item.type ? shipTypeClass(item.type) : "";
              return cls ? ` ${i18nT(`replay.classes.${cls}`)}` : "";
            })()}
            {item.maxHp != null ? ` · ${Math.round(item.maxHp).toLocaleString()} HP` : ""}
          </span>
        </span>
        {/* Scripted NPCs have no player name (their label name
            IS the ship name) and no stats — keep the row to a
            single identity and an empty stats slot. */}
        {item.scripted ? null : (
          <span class="holo-map__cam-name">{item.name}</span>
        )}
        <span class="holo-map__cam-stats">
          {item.scripted ? "" : (props.followStats.get(item.entityId) ?? "…")}
        </span>
      </button>
    );

    /** One followable aircraft row: plane glyph + carrier label + group
     *  name. No tier/class/HP/stats — an air group carries none of the
     *  ship readouts; the selection still keys off the entity id (plane
     *  entities are synthesized above the ship id range). */
    const renderPlaneRow = (item: ShipLabel) => (
      <button
        key={item.entityId}
        class={[
          "holo-map__cam-item",
          PLANE_ROW_CLASS,
          item.entityId === props.selectedId ? "holo-map__cam-item--on" : "",
          item.dead ? "holo-map__cam-item--dead" : "",
        ]}
        onClick={() => props.onPickShip(item.entityId)}
      >
        <span class="holo-map__cam-ico">
          <BattleIcon
            kind="plane"
            type={item.planeType ?? "attack"}
            variant={item.role === "enemy" ? "enemy" : "ally"}
            size={13}
          />
        </span>
        <span class="holo-map__cam-body">
          <span class="holo-map__cam-ship">{item.shipName}</span>
          <span class="holo-map__cam-meta">{i18nT("replay.camera.aircraft")}</span>
        </span>
        <span class="holo-map__cam-name">{item.name}</span>
      </button>
    );

    return () => (
      <div class="holo-map__camera">
        <span ref={triggerWrap} class="holo-map__camera-trigger">
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
        </span>
        <HkPopover
          modelValue={props.open}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) props.onToggleMenu();
          }}
          anchorRef={triggerWrap.value}
          placement="top-start"
          sheetOnMobile
          title={i18nT("replay.camera.title")}
        >
          {/* Scroll region: hikari's HkScrollContainer owns the scrollbar
              (auto-hiding overlay track on the menu's right edge); the
              roster list scrolls inside its viewport. The click guard
              spreads in (the component's props declare no DOM events;
              Vue's attr fallthrough still lands it on the root, covering
              the overlay track as well). */}
          <HkScrollContainer
            class="holo-map__cam-menu"
            {...{ onClick: (e: MouseEvent) => e.stopPropagation() }}
          >
            <div class="holo-map__cam-menu-inner">
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
            {/* What the replay's own camera was doing — a caption under the
                mode buttons, not a selectable mode. */}
            {props.recordedMode ? (
              <div class="holo-map__cam-recorded">
                {i18nT("replay.camera.recorded", { mode: recordedModeLabel(props.recordedMode) })}
              </div>
            ) : null}
            {props.hasPlaneCameraWindow ? (
              <button
                class="holo-map__cam-planejump"
                onClick={() => props.onJumpPlaneCamera()}
              >
                <Plane size={13} />
                {i18nT("replay.camera.jumpPlaneCamera")}
              </button>
            ) : null}
            {props.groups.map((g) => (
              <div key={g.key} class="holo-map__cam-group">
                <div class="holo-map__cam-group-title">{g.title}</div>
                {g.items.map((item) =>
                  item.kind === "plane" ? renderPlaneRow(item) : renderShipRow(item),
                )}
              </div>
            ))}
            </div>
          </HkScrollContainer>
        </HkPopover>
      </div>
    );
  },
});
