/**
 * Tactical-board toolbar: one compact horizontal bar in the board dock.
 * Frequently-used tools sit directly on the bar; everything else collapses
 * into popovers that open upward — shapes, unit markers, the colour/width/
 * dash style sheet and a slim "more" panel (the behaviour switches + the
 * annotation count). Exports live behind the bar's rightmost button, which
 * opens the standalone ExportWizardModal (a two-step stepper).
 *
 * Every flyout is hikari machinery, not hand-rolled chrome: HkPopover
 * (anchored, auto-flipping, phone bottom-sheet) carries the panel and tool
 * lists render as HkMenuPanel + HkMenuActionItem rows (icon + label +
 * shortcut suffix, active row via the host's is-active class) — the same
 * primitives the filter chips and admin menus are built on.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from "vue";
import {
  HkIconButton,
  HkMenuActionItem,
  HkMenuPanel,
  HkPopover,
  HkSwitch,
  HkTooltip,
  useBreakpoint,
} from "@celestia-island/hikari";
import {
  Anchor,
  ArrowRight,
  ChevronUp,
  Circle,
  Crosshair,
  Eraser,
  Eye,
  EyeOff,
  FileOutput,
  Flame,
  FlipHorizontal,
  Footprints,
  Hand,
  MapPin,
  Minus,
  MoreHorizontal,
  MousePointer2,
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
  Waypoints,
  ZoomIn,
  ZoomOut,
} from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { TacticalStore } from "./useTactical";
import { TACTICAL_PALETTE, TACTICAL_WIDTHS } from "./useTactical";
import { ACTION_KINDS } from "./plan";
import type { HeatLayerMode, HeatOverlayData } from "./heatLayer";
import type { DashStyle, TacticalActionKind, TacticalToolId } from "./types";
import ExportWizardModal from "./ExportWizardModal";
import "./TacticalToolbar.scss";

interface ExportSettings {
  format: "png" | "webp";
  scale: 1 | 2;
  timestamp: boolean;
  minimap: boolean;
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
  zoomIn: () => void;
  zoomOut: () => void;
}

/** Live viewport zoom readout for the bar's −/％/＋ group. */
export interface TacticalViewZoom {
  percent: number;
  canIn: boolean;
  canOut: boolean;
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

/** Heat-overlay menu rows (the toolbar's 热力 flyout): off / ship-track
 *  heat / spawn heat — the corpus grids the tactics page resolves for the
 *  current (map, mode). */
const HEAT_ROWS: { mode: HeatLayerMode; icon: typeof Pen; key: string }[] = [
  { mode: "off", icon: EyeOff, key: "tactics.toolbar.heatOff" },
  { mode: "track", icon: Footprints, key: "tactics.toolbar.heatTrack" },
  { mode: "spawn", icon: Anchor, key: "tactics.toolbar.heatSpawn" },
];

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
    /** Viewport zoom readout + step guards for the −/％/＋ group. */
    viewZoom: { type: Object as PropType<TacticalViewZoom>, required: true },
    /** Plan board: markers are keyframes, so the marker menu gains the action
     *  kind picker and loses the replay-only path pin. */
    plan: { type: Boolean, default: false },
    /** Unit mode (a lineup drives the board): free hull stamping is OFF —
     *  units arrive from the lineup editor — and the bar gains the
     *  auto-mirror toggle (orders replicate to the paired hull) and the
     *  capture-point layer toggle. */
    lineupMode: { type: Boolean, default: false },
    mirror: { type: Boolean, default: false },
    onToggleMirror: { type: Function as PropType<() => void>, default: undefined },
    showCaps: { type: Boolean, default: true },
    onToggleCaps: { type: Function as PropType<() => void>, default: undefined },
    /** Corpus heat overlay (heatLayer.ts): UNDEFINED = this host wires no
     *  heat layer (the replay board hides the button); NULL = wired but the
     *  current (map, mode) has no corpus coverage (the button renders
     *  disabled with the no-data hint). */
    heat: { type: Object as PropType<HeatOverlayData | null>, default: undefined },
    heatMode: { type: String as PropType<HeatLayerMode>, default: "off" },
    onSetHeat: { type: Function as PropType<(mode: HeatLayerMode) => void>, default: undefined },
  },
  setup(props) {
    const { isMobile } = useBreakpoint();
    const tool = computed(() => props.store.tool.value);
    const style = computed(() => props.store.style.value);
    const markerTools = computed(() => (props.plan ? PLAN_MARKER_TOOLS : MARKER_TOOLS));

    /** Which popover is open (null = none). One at a time — opening one
     *  closes the previous. */
    const open = ref<string | null>(null);
    function toggle(id: string): void {
      open.value = open.value === id ? null : id;
    }
    function close(): void {
      open.value = null;
    }

    // HkPopover only closes on outside clicks when its backdrop is active
    // (our phone sheets); on desktop the filter-chip convention carries a
    // capture-phase closer of its own — presses inside the bar or inside
    // any open hikari popup (this panel, a nested select popout) count as
    // inside, everything else dismisses.
    const barRoot = ref<HTMLElement | null>(null);
    function onDocPointerDown(e: PointerEvent): void {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (barRoot.value?.contains(target)) return;
      if (target.closest(".hk-popover-panel")) return;
      close();
    }
    watch(open, (v, old) => {
      if (v != null && old == null) {
        document.addEventListener("pointerdown", onDocPointerDown, true);
      } else if (v == null) {
        document.removeEventListener("pointerdown", onDocPointerDown, true);
      }
    });
    onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointerDown, true));
    /** Anchors: wrapping spans around each trigger button (HkPopover
     *  positions against the element, same wiring as the filter chips). */
    const shapeBtn = ref<HTMLElement | null>(null);
    const markerBtn = ref<HTMLElement | null>(null);
    const styleBtn = ref<HTMLElement | null>(null);
    const moreBtn = ref<HTMLElement | null>(null);
    const heatBtn = ref<HTMLElement | null>(null);
    /** The standalone export wizard (the bar's rightmost button). */
    const wizardOpen = ref(false);

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
        <HkTooltip key={tl.id} text={i18nT(`replay.tactical.${tl.key}`)} placement="top">
          <HkIconButton
            variant={tool.value === tl.id ? "primary" : "ghost"}
            size={32}
            onClick={() => {
              props.store.tool.value = tl.id;
              close();
              onPick?.();
            }}
          >
            <Icon size={14} />
          </HkIconButton>
        </HkTooltip>
      );
    };

    /** One tool row in a menu panel: icon + label + shortcut suffix, the
     *  active tool highlighted through the host's is-active class. */
    const menuRow = (tl: ToolMeta) => {
      const Icon = tl.icon;
      const hint = TOOL_KEY_HINTS[tl.id];
      return (
        <HkMenuActionItem
          key={tl.id}
          icon={<Icon size={14} />}
          label={i18nT(`replay.tactical.${tl.key}`)}
          class={tool.value === tl.id ? "is-active" : ""}
          onClick={() => {
            props.store.tool.value = tl.id;
            close();
          }}
        >
          {hint ? { suffix: () => <kbd class="tac-pop__kbd">{hint}</kbd> } : undefined}
        </HkMenuActionItem>
      );
    };

    /** Shared popover wiring (the filter chips' convention): close-only
     *  model update, anchored placement, phone bottom-sheet. */
    const popoverProps = (id: string, anchor: () => HTMLElement | null, edge = false) => ({
      modelValue: open.value === id,
      "onUpdate:modelValue": (v: boolean) => {
        if (!v && open.value === id) close();
      },
      anchorRef: anchor(),
      placement: edge ? ("top-end" as const) : ("top-start" as const),
      closeOnBackdrop: isMobile.value,
      sheetOnMobile: true,
    });

    return () => (
      <div ref={barRoot} class="tac-bar" onClick={(e: MouseEvent) => e.stopPropagation()}>
        {/* The plan board has no tool modes (drag pans, clicking a hull
            selects it and drag draws its trajectory); the replay
            annotation host keeps the full tool set. */}
        {!props.plan ? (
          <>
        {BAR_TOOLS.map((tl) => toolButton(tl))}

        {/* Shapes + text */}
        <span ref={shapeBtn} class={["tac-bar__group", isShapeTool.value ? "tac-bar__group--on" : ""]}>
          <HkTooltip text={i18nT("replay.tactical.menu.shapes")} placement="top">
            <HkIconButton
              variant={isShapeTool.value ? "primary" : "ghost"}
              size={32}
              onClick={() => toggle("shapes")}
            >
              {isShapeTool.value ? <shapeIcon.value size={14} /> : <ChevronUp size={14} />}
            </HkIconButton>
          </HkTooltip>
          <HkPopover {...popoverProps("shapes", () => shapeBtn.value)} title={i18nT("replay.tactical.menu.shapes")}>
            <HkMenuPanel label={i18nT("replay.tactical.menu.shapes")}>
              {SHAPE_TOOLS.map((tl) => menuRow(tl))}
            </HkMenuPanel>
          </HkPopover>
        </span>

        {/* Unit markers + path pin (unit mode: the lineup owns units, the
            group hides entirely) */}
        {!props.lineupMode ? (
          <span ref={markerBtn} class={["tac-bar__group", isMarkerTool.value ? "tac-bar__group--on" : ""]}>
            <HkTooltip text={i18nT("replay.tactical.menu.markers")} placement="top">
              <HkIconButton
                variant={isMarkerTool.value ? "primary" : "ghost"}
                size={32}
                onClick={() => toggle("markers")}
              >
                {isMarkerTool.value ? <markerIcon.value size={14} /> : <Ship size={14} />}
              </HkIconButton>
            </HkTooltip>
            <HkPopover {...popoverProps("markers", () => markerBtn.value)} title={i18nT("replay.tactical.menu.markers")}>
              <HkMenuPanel label={i18nT("replay.tactical.menu.markers")}>
                {markerTools.value.map((tl) => menuRow(tl))}
              </HkMenuPanel>
              {props.plan ? (
                <div class="tac-pop__extras">
                  <div class="tac-pop__sep" />
                  <div class="tac-pop__label">{i18nT("replay.tactical.plan.actionLabel")}</div>
                  <div class="tac-pop__row">
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
                </div>
              ) : null}
            </HkPopover>
          </span>
        ) : null}

        {/* Style: colour swatch (opens palette + width + dash) */}
        <span ref={styleBtn} class="tac-bar__group">
          <HkTooltip text={i18nT("replay.tactical.style.color")} placement="top">
            <button
              class={["tac-bar__color", open.value === "style" ? "tac-bar__color--on" : ""]}
              style={{ background: style.value.color }}
              onClick={() => toggle("style")}
            >
              <Palette size={12} class="tac-bar__color-ico" />
            </button>
          </HkTooltip>
          <HkPopover {...popoverProps("style", () => styleBtn.value)} title={i18nT("replay.tactical.style.color")}>
            <div class="tac-pop tac-pop--wide">
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
              <div class="tac-pop__row">
                {TACTICAL_WIDTHS.map((w) => (
                  <button
                    key={w}
                    class={["tac-bar__width", style.value.width === w ? "tac-bar__width--on" : ""]}
                    data-hint={i18nT("replay.tactical.style.width")}
                    aria-label={i18nT("replay.tactical.style.width")}
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
                    data-hint={i18nT(`replay.tactical.style.dash.${d}`)}
                    aria-label={i18nT(`replay.tactical.style.dash.${d}`)}
                    onClick={() => {
                      props.store.style.value = { ...style.value, dash: d };
                    }}
                  />
                ))}
              </div>
            </div>
          </HkPopover>
        </span>
          </>
        ) : null}

        {props.lineupMode && props.onToggleMirror ? (
          <HkTooltip text={i18nT("tactics.toolbar.mirror")} placement="top">
            <HkIconButton
              size={32}
              variant={props.mirror ? "primary" : "ghost"}
              onClick={() => props.onToggleMirror!()}
            >
              <FlipHorizontal size={14} />
            </HkIconButton>
          </HkTooltip>
        ) : null}
        {props.plan && props.onToggleCaps ? (
          <HkTooltip text={i18nT("tactics.toolbar.caps")} placement="top">
            <HkIconButton
              size={32}
              variant={props.showCaps ? "primary" : "ghost"}
              onClick={() => props.onToggleCaps!()}
            >
              <MapPin size={14} />
            </HkIconButton>
          </HkTooltip>
        ) : null}

        {/* Corpus heat overlay (the 热力 flyout): off / track / spawn rows
            against the current (map, mode)'s community-replay grids. The
            whole group only exists on hosts that wire the layer (the plan
            page); without corpus coverage the trigger stays disabled with
            the no-data hint as its tooltip. */}
        {props.heat !== undefined ? (
          <span
            ref={heatBtn}
            class={["tac-bar__group", props.heatMode !== "off" ? "tac-bar__group--on" : ""]}
          >
            <HkTooltip
              text={
                props.heat == null
                  ? i18nT("tactics.toolbar.heatNone")
                  : i18nT("tactics.toolbar.heat")
              }
              placement="top"
            >
              <HkIconButton
                size={32}
                disabled={props.heat == null}
                variant={props.heatMode !== "off" ? "primary" : "ghost"}
                onClick={() => toggle("heat")}
              >
                <Flame size={14} />
              </HkIconButton>
            </HkTooltip>
            <HkPopover {...popoverProps("heat", () => heatBtn.value)} title={i18nT("tactics.toolbar.heat")}>
              <HkMenuPanel label={i18nT("tactics.toolbar.heat")}>
                {HEAT_ROWS.map((row) => {
                  const Icon = row.icon;
                  const uncovered = row.mode !== "off" && props.heat?.[row.mode] == null;
                  return (
                    <HkMenuActionItem
                      key={row.mode}
                      icon={<Icon size={14} />}
                      label={i18nT(row.key)}
                      disabled={uncovered}
                      class={props.heatMode === row.mode ? "is-active" : ""}
                      onClick={() => {
                        props.onSetHeat?.(row.mode);
                        close();
                      }}
                    />
                  );
                })}
              </HkMenuPanel>
            </HkPopover>
          </span>
        ) : null}

        <span class="tac-bar__sep" />

        {/* Viewport zoom: one wheel-notch rung per press, anchored on the
            centre; the percent button doubles as reset-to-fit. */}
        <HkTooltip text={i18nT("replay.tactical.view.zoomOut")} placement="top">
          <HkIconButton
            size={32}
            disabled={!props.viewZoom.canOut}
            onClick={() => props.actions.zoomOut()}
          >
            <ZoomOut size={14} />
          </HkIconButton>
        </HkTooltip>
        <HkTooltip text={i18nT("replay.tactical.view.reset")} placement="top">
          <button class="tac-bar__zoom-pct" onClick={() => props.actions.resetView()}>
            {props.viewZoom.percent}%
          </button>
        </HkTooltip>
        <HkTooltip text={i18nT("replay.tactical.view.zoomIn")} placement="top">
          <HkIconButton
            size={32}
            disabled={!props.viewZoom.canIn}
            onClick={() => props.actions.zoomIn()}
          >
            <ZoomIn size={14} />
          </HkIconButton>
        </HkTooltip>

        <span class="tac-bar__sep" />

        <HkTooltip text={i18nT("replay.tactical.action.undo")} placement="top">
          <HkIconButton size={32} disabled={!props.store.canUndo.value} onClick={() => props.store.undo()}>
            <Undo2 size={14} />
          </HkIconButton>
        </HkTooltip>
        <HkTooltip text={i18nT("replay.tactical.action.redo")} placement="top">
          <HkIconButton size={32} disabled={!props.store.canRedo.value} onClick={() => props.store.redo()}>
            <Redo2 size={14} />
          </HkIconButton>
        </HkTooltip>

        <span class="tac-bar__sep" />

        {props.hasSelection ? (
          <HkTooltip text={i18nT("replay.tactical.action.delete")} placement="top">
            <HkIconButton
              size={32}
              variant="danger"
              onClick={() => {
                const id = props.store.selectedId.value;
                if (id) props.store.removeElement(id);
              }}
            >
              <Trash2 size={14} />
            </HkIconButton>
          </HkTooltip>
        ) : (
          <HkTooltip text={i18nT("replay.tactical.action.clear")} placement="top">
            <HkIconButton
              size={32}
              variant="danger"
              disabled={props.store.elements.value.length === 0}
              onClick={() => props.store.clearAll()}
            >
              <Trash2 size={14} />
            </HkIconButton>
          </HkTooltip>
        )}
        {/* Everything else */}
        <span ref={moreBtn} class="tac-bar__group">
          <HkTooltip text={i18nT("replay.tactical.menu.more")} placement="top">
            <HkIconButton
              size={32}
              variant={open.value === "more" ? "primary" : "ghost"}
              onClick={() => toggle("more")}
            >
              <MoreHorizontal size={14} />
            </HkIconButton>
          </HkTooltip>
          <HkPopover {...popoverProps("more", () => moreBtn.value, true)} title={i18nT("replay.tactical.menu.more")}>
            <div class="tac-pop">
              <div class="tac-pop__label">{i18nT("replay.tactical.menu.behaviour")}</div>
              <div class="tac-bar__toggles">
                <HkSwitch
                  size="sm"
                  modelValue={props.store.anchorToTime.value}
                  onUpdate:modelValue={(v: boolean) => {
                    props.store.anchorToTime.value = v;
                  }}
                >
                  {i18nT("replay.tactical.time.anchor")}
                </HkSwitch>
                <HkSwitch
                  size="sm"
                  modelValue={props.store.showGhostFuture.value}
                  onUpdate:modelValue={(v: boolean) => {
                    props.store.showGhostFuture.value = v;
                  }}
                >
                  {i18nT("replay.tactical.time.ghost")}
                </HkSwitch>
              </div>
              <div class="tac-pop__sep" />
              <div class="tac-bar__count">
                {i18nT("replay.tactical.count", { n: props.store.elements.value.length })}
              </div>
            </div>
          </HkPopover>
        </span>

        {/* Export: its own button at the far end, opening the standalone
            wizard (settings step + runs step) instead of a crammed popover. */}
        <HkTooltip text={i18nT("replay.tactical.export.wizardTitle")} placement="top">
          <HkIconButton
            size={32}
            variant="primary"
            onClick={() => (wizardOpen.value = true)}
          >
            <FileOutput size={15} />
          </HkIconButton>
        </HkTooltip>

        <ExportWizardModal
          modelValue={wizardOpen.value}
          onUpdate:modelValue={(v: boolean) => (wizardOpen.value = v)}
          exportSettings={props.exportSettings}
          actions={props.actions}
          busy={props.busy}
          recording={props.recording}
          recordingSupported={props.recordingSupported}
          regionActive={props.regionActive}
          pendingRegion={props.pendingRegion}
          elementCount={props.store.elements.value.length}
        />
      </div>
    );
  },
});
