/**
 * Tactical-board toolbar: one compact horizontal bar docked at the map's
 * bottom-left (replacing the old right-side rail so the map keeps its full
 * size). Frequently-used tools sit directly on the bar; everything else
 * collapses into popovers that open upward — shapes, unit markers, the
 * colour/width/dash style sheet and a "more" menu holding the time-anchor
 * toggles, history, JSON import/export and the whole export/record group.
 * Built on hikari primitives (HIconButton, HTooltip, HSwitch) over the
 * stage's --holo-hud-* tokens.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from "vue";
import { HIconButton, HSwitch, HTooltip } from "@celestia-island/hikari";
import {
  ArrowRight,
  Camera,
  ChevronUp,
  Circle,
  Crop,
  Crosshair,
  Download,
  Eraser,
  Eye,
  FastForward,
  Hand,
  MousePointer2,
  Maximize2,
  Minus,
  MoreHorizontal,
  MoveRight,
  Palette,
  Pen,
  Plane,
  Redo2,
  Route,
  Ship,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  Video,
  Waypoints,
} from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { TacticalStore } from "./useTactical";
import { TACTICAL_PALETTE, TACTICAL_WIDTHS } from "./useTactical";
import { ACTION_KINDS } from "./plan";
import type { DashStyle, TacticalActionKind, TacticalToolId } from "./types";
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
  exportJson: () => void;
  importJson: () => void;
  resetView: () => void;
}

interface ToolMeta {
  id: TacticalToolId;
  icon: typeof Pen;
  key: string;
}

const BAR_TOOLS: ToolMeta[] = [
  { id: "select", icon: MousePointer2, key: "tools.select" },
  { id: "pen", icon: Pen, key: "tools.pen" },
  { id: "eraser", icon: Eraser, key: "tools.eraser" },
  { id: "hand", icon: Hand, key: "tools.hand" },
];

const SHAPE_TOOLS: ToolMeta[] = [
  { id: "line", icon: Minus, key: "tools.line" },
  { id: "arrow", icon: ArrowRight, key: "tools.arrow" },
  { id: "rect", icon: Square, key: "tools.rect" },
  { id: "ellipse", icon: Circle, key: "tools.ellipse" },
  { id: "text", icon: Type, key: "tools.text" },
];

const MARKER_TOOLS: ToolMeta[] = [
  { id: "markerShip", icon: Ship, key: "tools.markerShip" },
  { id: "markerPlane", icon: Plane, key: "tools.markerPlane" },
  { id: "markerRoute", icon: Waypoints, key: "tools.markerRoute" },
  { id: "pinPath", icon: Route, key: "tools.pinPath" },
];

/** Plan boards carry no replay, so the path pin (which picks a live ship)
 *  has nothing to pick — and the route tool would paint a hull that is
 *  neither a keyframe nor a timeline row, so both stay replay-only. */
const PLAN_MARKER_TOOLS: ToolMeta[] = MARKER_TOOLS.filter(
  (tl) => tl.id !== "pinPath" && tl.id !== "markerRoute",
);

/** Icons for the placement action kinds, in toolbar order. */
const ACTION_ICONS: Record<TacticalActionKind, typeof Pen> = {
  move: MoveRight,
  attack: Crosshair,
  spot: Eye,
};

const DASHES: DashStyle[] = ["solid", "dashed", "dotted"];

/** Keyboard shortcut shown next to a menu item (matches TacticalBoard's
 *  TOOL_KEYS). */
const TOOL_KEY_HINTS: Partial<Record<TacticalToolId, string>> = {
  select: "V",
  pen: "P",
  line: "L",
  arrow: "A",
  rect: "R",
  ellipse: "O",
  text: "T",
  markerShip: "H",
  markerPlane: "I",
  markerRoute: "M",
  pinPath: "G",
  eraser: "E",
  hand: "Space",
};

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
    /** Plan board: markers are keyframes, so the marker menu gains the action
     *  kind picker and loses the replay-only path pin. */
    plan: { type: Boolean, default: false },
  },
  setup(props) {
    const tool = computed(() => props.store.tool.value);
    const style = computed(() => props.store.style.value);
    const markerTools = computed(() => (props.plan ? PLAN_MARKER_TOOLS : MARKER_TOOLS));

    /** Which popover is open (null = none). One at a time. */
    const open = ref<string | null>(null);
    function toggle(id: string): void {
      open.value = open.value === id ? null : id;
    }
    function close(): void {
      open.value = null;
    }
    function onWindowPointerDown(e: PointerEvent): void {
      if (!(e.target as HTMLElement).closest(".tac-bar__anchor")) close();
    }
    watch(open, (v, old) => {
      if (v != null && old == null) window.addEventListener("pointerdown", onWindowPointerDown, true);
      if (v == null) window.removeEventListener("pointerdown", onWindowPointerDown, true);
    });
    onBeforeUnmount(() => window.removeEventListener("pointerdown", onWindowPointerDown, true));

    /** Pick the popover button's icon: the active sub-tool when one of the
     *  group's tools is selected, else the group glyph. */
    const shapeIcon = computed(
      () => SHAPE_TOOLS.find((tl) => tl.id === tool.value)?.icon ?? SHAPE_TOOLS[0].icon,
    );
    const markerIcon = computed(
      () => markerTools.value.find((tl) => tl.id === tool.value)?.icon ?? markerTools.value[0].icon,
    );
    const isShapeTool = computed(() => SHAPE_TOOLS.some((tl) => tl.id === tool.value));
    const isMarkerTool = computed(() => markerTools.value.some((tl) => tl.id === tool.value));

    const toolButton = (tl: ToolMeta, onPick?: () => void) => {
      const Icon = tl.icon;
      return (
        <HTooltip key={tl.id} text={i18nT(`replay.tactical.${tl.key}`)} placement="top">
          <HIconButton
            variant={tool.value === tl.id ? "primary" : "ghost"}
            size={32}
            onClick={() => {
              props.store.tool.value = tl.id;
              close();
              onPick?.();
            }}
          >
            <Icon size={14} />
          </HIconButton>
        </HTooltip>
      );
    };

    const menuItem = (tl: ToolMeta) => {
      const Icon = tl.icon;
      const hint = TOOL_KEY_HINTS[tl.id];
      return (
        <button
          key={tl.id}
          class={["tac-bar__item", tool.value === tl.id ? "tac-bar__item--on" : ""]}
          onClick={() => {
            props.store.tool.value = tl.id;
            close();
          }}
        >
          <Icon size={14} />
          <span>{i18nT(`replay.tactical.${tl.key}`)}</span>
          {hint ? <kbd>{hint}</kbd> : null}
        </button>
      );
    };

    return () => (
      <div class="tac-bar" onClick={(e: MouseEvent) => e.stopPropagation()}>
        {BAR_TOOLS.map((tl) => toolButton(tl))}

        {/* Shapes + text */}
        <span class={["tac-bar__anchor", isShapeTool.value ? "tac-bar__anchor--on" : ""]}>
          <HTooltip text={i18nT("replay.tactical.menu.shapes")} placement="top">
            <HIconButton
              variant={isShapeTool.value ? "primary" : "ghost"}
              size={32}
              onClick={() => toggle("shapes")}
            >
              {isShapeTool.value ? <shapeIcon.value size={14} /> : <ChevronUp size={14} />}
            </HIconButton>
          </HTooltip>
          {open.value === "shapes" ? (
            <div class="tac-bar__pop">
              {SHAPE_TOOLS.map((tl) => menuItem(tl))}
            </div>
          ) : null}
        </span>

        {/* Unit markers + path pin */}
        <span class={["tac-bar__anchor", isMarkerTool.value ? "tac-bar__anchor--on" : ""]}>
          <HTooltip text={i18nT("replay.tactical.menu.markers")} placement="top">
            <HIconButton
              variant={isMarkerTool.value ? "primary" : "ghost"}
              size={32}
              onClick={() => toggle("markers")}
            >
              {isMarkerTool.value ? <markerIcon.value size={14} /> : <Ship size={14} />}
            </HIconButton>
          </HTooltip>
          {open.value === "markers" ? (
            <div class="tac-bar__pop">
              {markerTools.value.map((tl) => menuItem(tl))}
              {props.plan ? (
                <>
                  <div class="tac-bar__pop-sep" />
                  <div class="tac-bar__field-label">{i18nT("replay.tactical.plan.actionLabel")}</div>
                  <div class="tac-bar__row">
                    {ACTION_KINDS.map((kind) => {
                      const Icon = ACTION_ICONS[kind];
                      const on = props.store.actionKind.value === kind;
                      return (
                        <button
                          key={kind}
                          class={["tac-bar__item", on ? "tac-bar__item--on" : ""]}
                          onClick={() => {
                            props.store.actionKind.value = kind;
                          }}
                        >
                          <Icon size={14} />
                          <span>{i18nT(`replay.tactical.plan.act.${kind}`)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p class="tac-bar__note">{i18nT("replay.tactical.plan.hint")}</p>
                </>
              ) : null}
            </div>
          ) : null}
        </span>

        {/* Style: colour swatch (opens palette + width + dash) */}
        <span class="tac-bar__anchor">
          <HTooltip text={i18nT("replay.tactical.style.color")} placement="top">
            <button
              class={["tac-bar__color", open.value === "style" ? "tac-bar__color--on" : ""]}
              style={{ background: style.value.color }}
              onClick={() => toggle("style")}
            >
              <Palette size={12} class="tac-bar__color-ico" />
            </button>
          </HTooltip>
          {open.value === "style" ? (
            <div class="tac-bar__pop tac-bar__pop--wide">
              <div class="tac-bar__swatches">
                {TACTICAL_PALETTE.map((c) => (
                  <button
                    key={c}
                    class={[
                      "tac-bar__swatch",
                      style.value.color.toLowerCase() === c.toLowerCase() ? "tac-bar__swatch--on" : "",
                    ]}
                    style={{ background: c }}
                    onClick={() => {
                      props.store.style.value = { ...style.value, color: c };
                    }}
                  />
                ))}
              </div>
              <div class="tac-bar__row">
                {TACTICAL_WIDTHS.map((w) => (
                  <button
                    key={w}
                    class={["tac-bar__width", style.value.width === w ? "tac-bar__width--on" : ""]}
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
                    class={["tac-bar__dash", `tac-bar__dash--${d}`, style.value.dash === d ? "tac-bar__dash--on" : ""]}
                    title={i18nT(`replay.tactical.style.dash.${d}`)}
                    onClick={() => {
                      props.store.style.value = { ...style.value, dash: d };
                    }}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </span>

        <span class="tac-bar__sep" />

        <HTooltip text={i18nT("replay.tactical.action.undo")} placement="top">
          <HIconButton size={32} disabled={!props.store.canUndo.value} onClick={() => props.store.undo()}>
            <Undo2 size={14} />
          </HIconButton>
        </HTooltip>
        <HTooltip text={i18nT("replay.tactical.action.redo")} placement="top">
          <HIconButton size={32} disabled={!props.store.canRedo.value} onClick={() => props.store.redo()}>
            <Redo2 size={14} />
          </HIconButton>
        </HTooltip>

        <span class="tac-bar__sep" />

        {props.hasSelection ? (
          <HTooltip text={i18nT("replay.tactical.action.delete")} placement="top">
            <HIconButton
              size={32}
              variant="danger"
              onClick={() => {
                const id = props.store.selectedId.value;
                if (id) props.store.removeElement(id);
              }}
            >
              <Trash2 size={14} />
            </HIconButton>
          </HTooltip>
        ) : (
          <HTooltip text={i18nT("replay.tactical.action.clear")} placement="top">
            <HIconButton
              size={32}
              variant="danger"
              disabled={props.store.elements.value.length === 0}
              onClick={() => props.store.clearAll()}
            >
              <Trash2 size={14} />
            </HIconButton>
          </HTooltip>
        )}

        {/* Everything else */}
        <span class="tac-bar__anchor tac-bar__anchor--right">
          <HTooltip text={i18nT("replay.tactical.menu.more")} placement="top">
            <HIconButton
              size={32}
              variant={open.value === "more" ? "primary" : "ghost"}
              onClick={() => toggle("more")}
            >
              <MoreHorizontal size={14} />
            </HIconButton>
          </HTooltip>
          {open.value === "more" ? (
            <div class="tac-bar__pop tac-bar__pop--wide tac-bar__pop--right">
              <div class="tac-bar__toggles">
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
                <button class="tac-bar__item" onClick={() => { props.actions.resetView(); close(); }}>
                  <Maximize2 size={14} />
                  <span>{i18nT("replay.tactical.view.reset")}</span>
                </button>
              </div>
              <div class="tac-bar__pop-sep" />
              <div class="tac-bar__grid">
                <label class="tac-bar__field">
                  <span class="tac-bar__field-label">{i18nT("replay.tactical.export.format")}</span>
                  <select
                    class="tac-bar__select"
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
                <label class="tac-bar__field">
                  <span class="tac-bar__field-label">{i18nT("replay.tactical.export.scale")}</span>
                  <select
                    class="tac-bar__select"
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
                <label class="tac-bar__field">
                  <span class="tac-bar__field-label">{i18nT("replay.tactical.export.range")}</span>
                  <select
                    class="tac-bar__select"
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
                <label class="tac-bar__field">
                  <span class="tac-bar__field-label">{i18nT("replay.tactical.export.fps")}</span>
                  <select
                    class="tac-bar__select"
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
              </div>
              <HSwitch
                modelValue={props.exportSettings.timestamp}
                onUpdate:modelValue={(v: boolean) => {
                  props.exportSettings.timestamp = v;
                }}
              >
                {i18nT("replay.tactical.export.timestamp")}
              </HSwitch>
              <div class="tac-bar__row tac-bar__row--actions">
                <HTooltip text={i18nT("replay.tactical.export.full")} placement="top">
                  <HIconButton size={32} disabled={props.busy} onClick={() => { props.actions.exportFull(); close(); }}>
                    <Camera size={14} />
                  </HIconButton>
                </HTooltip>
                <HTooltip
                  text={
                    props.pendingRegion
                      ? i18nT("replay.tactical.export.regionRun")
                      : i18nT("replay.tactical.export.region")
                  }
                  placement="top"
                >
                  <HIconButton
                    size={32}
                    variant={props.regionActive || props.pendingRegion ? "primary" : "ghost"}
                    disabled={props.busy}
                    onClick={() => { props.actions.exportRegion(); close(); }}
                  >
                    <Crop size={14} />
                  </HIconButton>
                </HTooltip>
                <HTooltip
                  text={
                    props.recording
                      ? i18nT("replay.tactical.record.stop")
                      : i18nT("replay.tactical.record.start")
                  }
                  placement="top"
                >
                  <HIconButton
                    size={32}
                    variant={props.recording ? "danger" : "ghost"}
                    disabled={props.busy || (!props.recording && !props.recordingSupported)}
                    onClick={() => { props.actions.recordToggle(); close(); }}
                  >
                    <Video size={14} />
                  </HIconButton>
                </HTooltip>
                <HTooltip text={i18nT("replay.tactical.export.offline")} placement="top">
                  <HIconButton
                    size={32}
                    variant="primary"
                    disabled={props.busy || props.recording}
                    onClick={() => { props.actions.offlineExport(); close(); }}
                  >
                    <FastForward size={14} />
                  </HIconButton>
                </HTooltip>
                <HTooltip text={i18nT("replay.tactical.action.exportJson")} placement="top">
                  <HIconButton size={32} disabled={props.busy} onClick={() => { props.actions.exportJson(); close(); }}>
                    <Download size={14} />
                  </HIconButton>
                </HTooltip>
                <HTooltip text={i18nT("replay.tactical.action.importJson")} placement="top">
                  <HIconButton size={32} disabled={props.busy} onClick={() => { props.actions.importJson(); close(); }}>
                    <Upload size={14} />
                  </HIconButton>
                </HTooltip>
              </div>
              <div class="tac-bar__count">
                {i18nT("replay.tactical.count", { n: props.store.elements.value.length })}
              </div>
            </div>
          ) : null}
        </span>
      </div>
    );
  },
});
