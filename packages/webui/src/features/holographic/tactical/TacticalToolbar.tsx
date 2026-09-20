/**
 * Tactical-board toolbar: a floating rail beside the 2D map with the tool
 * group, style controls (palette / width / dash), time anchoring, history
 * actions and the export/record group. Built on hikari primitives
 * (HIconButton, HTooltip, HSwitch) over the stage's --holo-hud-* tokens so
 * it reads as part of the holographic HUD in both themes.
 */
import { computed, defineComponent, type PropType } from "vue";
import { HIconButton, HSwitch, HTooltip } from "@celestia-island/hikari";
import {
  ArrowRight,
  Camera,
  Circle,
  Crop,
  FastForward,
  MousePointer2,
  Minus,
  Pen,
  Plane,
  Redo2,
  Route,
  Ship,
  Square,
  Trash2,
  Type,
  Undo2,
  Video,
} from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { TacticalStore } from "./useTactical";
import { TACTICAL_PALETTE, TACTICAL_WIDTHS } from "./useTactical";
import type { DashStyle, TacticalToolId } from "./types";
import "./TacticalToolbar.scss";

interface ExportSettings {
  format: "png" | "webp";
  scale: 1 | 2;
  timestamp: boolean;
  offlineFps: 30 | 60;
  offlineFrom: "now" | "start";
}

/** Board-provided callbacks (plain props — avoids the JSX kebab-case emit
 *  binding quirk and keeps the pair explicitly wired). */
export interface TacticalToolbarActions {
  exportFull: () => void;
  exportRegion: () => void;
  recordToggle: () => void;
  offlineExport: () => void;
}

const TOOLS: { id: TacticalToolId; icon: typeof Pen; key: string }[] = [
  { id: "select", icon: MousePointer2, key: "tools.select" },
  { id: "pen", icon: Pen, key: "tools.pen" },
  { id: "line", icon: Minus, key: "tools.line" },
  { id: "arrow", icon: ArrowRight, key: "tools.arrow" },
  { id: "rect", icon: Square, key: "tools.rect" },
  { id: "ellipse", icon: Circle, key: "tools.ellipse" },
  { id: "text", icon: Type, key: "tools.text" },
  { id: "markerShip", icon: Ship, key: "tools.markerShip" },
  { id: "markerPlane", icon: Plane, key: "tools.markerPlane" },
  { id: "pinPath", icon: Route, key: "tools.pinPath" },
];

const DASHES: DashStyle[] = ["solid", "dashed", "dotted"];

export default defineComponent({
  name: "TacticalToolbar",
  props: {
    store: { type: Object as PropType<TacticalStore>, required: true },
    regionActive: { type: Boolean, default: false },
    pendingRegion: { type: Boolean, default: false },
    recording: { type: Boolean, default: false },
    recordingSupported: { type: Boolean, default: true },
    busy: { type: Boolean, default: false },
    exportSettings: { type: Object as PropType<ExportSettings>, required: true },
    actions: { type: Object as PropType<TacticalToolbarActions>, required: true },
    hasSelection: { type: Boolean, default: false },
  },
  setup(props) {
    const tool = computed(() => props.store.tool.value);
    const style = computed(() => props.store.style.value);
    const isDrawTool = computed(() =>
      ["pen", "line", "arrow", "rect", "ellipse", "markerShip", "markerPlane", "pinPath"].includes(
        tool.value,
      ),
    );

    return () => (
      <div class="tac-rail" onClick={(e: MouseEvent) => e.stopPropagation()}>
        <div class="tac-rail__group tac-rail__tools">
          {TOOLS.map((tl) => {
            const Icon = tl.icon;
            return (
              <HTooltip key={tl.id} text={i18nT(`replay.tactical.${tl.key}`)} placement="left">
                <HIconButton
                  variant={tool.value === tl.id ? "primary" : "ghost"}
                  size={32}
                  onClick={() => {
                    props.store.tool.value = tl.id;
                  }}
                >
                  <Icon size={15} />
                </HIconButton>
              </HTooltip>
            );
          })}
        </div>

        <div class="tac-rail__sep" />

        <div class="tac-rail__group tac-rail__swatches">
          {TACTICAL_PALETTE.map((c) => (
            <button
              key={c}
              class={[
                "tac-rail__swatch",
                style.value.color.toLowerCase() === c.toLowerCase() ? "tac-rail__swatch--on" : "",
              ]}
              style={{ background: c }}
              title={i18nT("replay.tactical.style.color")}
              onClick={() => {
                props.store.style.value = { ...style.value, color: c };
              }}
            />
          ))}
        </div>

        {isDrawTool.value ? (
          <div class="tac-rail__group tac-rail__widths">
            {TACTICAL_WIDTHS.map((w) => (
              <button
                key={w}
                class={[
                  "tac-rail__width",
                  style.value.width === w ? "tac-rail__width--on" : "",
                ]}
                title={i18nT("replay.tactical.style.width")}
                onClick={() => {
                  props.store.style.value = { ...style.value, width: w };
                }}
              >
                <span style={{ width: `${Math.min(14, w + 2)}px`, height: `${Math.min(8, w / 2 + 1)}px` }} />
              </button>
            ))}
            {DASHES.map((d) => (
              <button
                key={d}
                class={[
                  "tac-rail__dash",
                  `tac-rail__dash--${d}`,
                  style.value.dash === d ? "tac-rail__dash--on" : "",
                ]}
                title={i18nT(`replay.tactical.style.dash.${d}`)}
                onClick={() => {
                  props.store.style.value = { ...style.value, dash: d };
                }}
              />
            ))}
          </div>
        ) : null}

        <div class="tac-rail__sep" />

        <div class="tac-rail__group tac-rail__toggles">
          <HSwitch
            modelValue={props.store.anchorToTime.value}
            onUpdate:modelValue={(v: boolean) => {
              props.store.anchorToTime.value = v;
            }}
          >
            {i18nT("replay.tactical.time.anchor")}
          </HSwitch>
          <HSwitch
            modelValue={props.store.showGhostFuture.value}
            onUpdate:modelValue={(v: boolean) => {
              props.store.showGhostFuture.value = v;
            }}
          >
            {i18nT("replay.tactical.time.ghost")}
          </HSwitch>
        </div>

        <div class="tac-rail__sep" />

        <div class="tac-rail__group">
          <HTooltip text={i18nT("replay.tactical.action.undo")} placement="left">
            <HIconButton
              size={32}
              disabled={!props.store.canUndo.value}
              onClick={() => props.store.undo()}
            >
              <Undo2 size={15} />
            </HIconButton>
          </HTooltip>
          <HTooltip text={i18nT("replay.tactical.action.redo")} placement="left">
            <HIconButton
              size={32}
              disabled={!props.store.canRedo.value}
              onClick={() => props.store.redo()}
            >
              <Redo2 size={15} />
            </HIconButton>
          </HTooltip>
          {props.hasSelection ? (
            <HTooltip text={i18nT("replay.tactical.action.delete")} placement="left">
              <HIconButton
                size={32}
                variant="danger"
                onClick={() => {
                  const id = props.store.selectedId.value;
                  if (id) props.store.removeElement(id);
                }}
              >
                <Trash2 size={15} />
              </HIconButton>
            </HTooltip>
          ) : (
            <HTooltip text={i18nT("replay.tactical.action.clear")} placement="left">
              <HIconButton
                size={32}
                variant="danger"
                disabled={props.store.elements.value.length === 0}
                onClick={() => props.store.clearAll()}
              >
                <Trash2 size={15} />
              </HIconButton>
            </HTooltip>
          )}
        </div>

        <div class="tac-rail__sep" />

        <div class="tac-rail__group tac-rail__export">
          <label class="tac-rail__field">
            <span class="tac-rail__field-label">{i18nT("replay.tactical.export.format")}</span>
            <select
              class="tac-rail__select"
              value={props.exportSettings.format}
              onChange={(e: Event) => {
                props.exportSettings.format =
                  (e.target as HTMLSelectElement).value === "webp" ? "webp" : "png";
              }}
            >
              <option value="png">PNG</option>
              <option value="webp">WebP</option>
            </select>
          </label>
          <label class="tac-rail__field">
            <span class="tac-rail__field-label">{i18nT("replay.tactical.export.scale")}</span>
            <select
              class="tac-rail__select"
              value={String(props.exportSettings.scale)}
              onChange={(e: Event) => {
                props.exportSettings.scale =
                  (e.target as HTMLSelectElement).value === "2" ? 2 : 1;
              }}
            >
              <option value="1">1×</option>
              <option value="2">2×</option>
            </select>
          </label>
          <HSwitch
            modelValue={props.exportSettings.timestamp}
            onUpdate:modelValue={(v: boolean) => {
              props.exportSettings.timestamp = v;
            }}
          >
            {i18nT("replay.tactical.export.timestamp")}
          </HSwitch>
          <HTooltip text={i18nT("replay.tactical.export.full")} placement="left">
            <HIconButton size={32} disabled={props.busy} onClick={() => props.actions.exportFull()}>
              <Camera size={15} />
            </HIconButton>
          </HTooltip>
          <HTooltip
            text={
              props.pendingRegion
                ? i18nT("replay.tactical.export.regionRun")
                : i18nT("replay.tactical.export.region")
            }
            placement="left"
          >
            <HIconButton
              size={32}
              variant={props.regionActive || props.pendingRegion ? "primary" : "ghost"}
              disabled={props.busy}
              onClick={() => props.actions.exportRegion()}
            >
              <Crop size={15} />
            </HIconButton>
          </HTooltip>
          <HTooltip
            text={
              props.recording
                ? i18nT("replay.tactical.record.stop")
                : i18nT("replay.tactical.record.start")
            }
            placement="left"
          >
            <HIconButton
              size={32}
              variant={props.recording ? "danger" : "ghost"}
              disabled={props.busy || (!props.recording && !props.recordingSupported)}
              onClick={() => props.actions.recordToggle()}
            >
              <Video size={15} />
            </HIconButton>
          </HTooltip>
        </div>

        {/* Offline export: faster-than-realtime render via WebCodecs. */}
        <div class="tac-rail__group tac-rail__export">
          <label class="tac-rail__field">
            <span class="tac-rail__field-label">{i18nT("replay.tactical.export.range")}</span>
            <select
              class="tac-rail__select"
              value={props.exportSettings.offlineFrom}
              onChange={(e: Event) => {
                props.exportSettings.offlineFrom =
                  (e.target as HTMLSelectElement).value === "start" ? "start" : "now";
              }}
            >
              <option value="now">{i18nT("replay.tactical.export.rangeNow")}</option>
              <option value="start">{i18nT("replay.tactical.export.rangeFull")}</option>
            </select>
          </label>
          <label class="tac-rail__field">
            <span class="tac-rail__field-label">{i18nT("replay.tactical.export.fps")}</span>
            <select
              class="tac-rail__select"
              value={String(props.exportSettings.offlineFps)}
              onChange={(e: Event) => {
                props.exportSettings.offlineFps =
                  (e.target as HTMLSelectElement).value === "60" ? 60 : 30;
              }}
            >
              <option value="30">30</option>
              <option value="60">60</option>
            </select>
          </label>
          <HTooltip text={i18nT("replay.tactical.export.offline")} placement="left">
            <HIconButton
              size={32}
              variant="primary"
              disabled={props.busy || props.recording}
              onClick={() => props.actions.offlineExport()}
            >
              <FastForward size={15} />
            </HIconButton>
          </HTooltip>
        </div>

        <div class="tac-rail__count">
          {i18nT("replay.tactical.count", { n: props.store.elements.value.length })}
        </div>
      </div>
    );
  },
});
