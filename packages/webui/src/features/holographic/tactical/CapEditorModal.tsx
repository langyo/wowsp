/**
 * Custom capture-point editor (the wizard's 自定义 second-level window).
 *
 * The map-setup step 2 offers measured layouts plus ONE custom entry; this
 * editor is where the custom layout is authored: a square map preview with
 * draggable rings (click empty water to add, drag to move, select to edit
 * radius/ownership or delete), the retired hand-made templates available as
 * STARTING POINTS inside this window (not in step 2), and a manual
 * replay-import path — pick any .wowsreplay (a Neptune-series practice
 * recording, say) and its exact cap set loads into the editor.
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  ref,
  watch,
  type PropType,
} from "vue";
import { HkButton, HkModal, HkPopupSelect, HkTag, useToast } from "@celestia-island/hikari";
import { Crosshair, Upload } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import { api, type LearnedCapLayout } from "@/api";
import { resolveMapMinimapUrl, type MapBounds } from "../modelLoader";
import { MODE_PRESETS, instantiateCaps, type CapSpec } from "./modes";
import "./CapEditorModal.scss";

const EDIT = 560; // logical drawing space of the preview canvas

export default defineComponent({
  name: "TacticalCapEditorModal",
  props: {
    modelValue: { type: Boolean, required: true },
    spaceId: { type: String, required: true },
    /** The layout being edited (session caps — the wizard's current pick). */
    initialCaps: { type: Array as PropType<CapSpec[]>, default: () => [] },
    getBounds: {
      type: Function as PropType<(spaceId: string) => MapBounds | null>,
      default: undefined,
    },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    /** Apply the edited layout. */
    apply: (_caps: CapSpec[]) => true,
  },
  setup(props, { emit }) {
    const toast = useToast();
    const caps = ref<CapSpec[]>([]);
    const selected = ref<number>(-1);
    const cvsRef = ref<HTMLCanvasElement | null>(null);
    const artUrl = computed(() => resolveMapMinimapUrl(props.spaceId));
    const bounds = computed<MapBounds | null>(() => props.getBounds?.(props.spaceId) ?? null);

    let artImg: HTMLImageElement | null = null;
    let artEpoch = 0;

    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          caps.value = props.initialCaps.map((c) => ({ ...c, at: { ...c.at } }));
          selected.value = -1;
          loadArt();
        }
      },
    );

    function loadArt(): void {
      const epoch = ++artEpoch;
      artImg = null;
      const url = artUrl.value;
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        if (epoch === artEpoch) artImg = img;
      };
      img.src = url;
    }

    // ── Projection (world ⇄ canvas), matching the board's frame ──────────
    const proj = computed(() => {
      const b = bounds.value;
      if (!b) return null;
      const w = b.maxX - b.minX || 1;
      const h = b.maxZ - b.minZ || 1;
      return {
        toPx: (p: { x: number; z: number }): { x: number; y: number } => ({
          x: ((p.x - b.minX) / w) * EDIT,
          y: ((b.maxZ - p.z) / h) * EDIT,
        }),
        toWorld: (px: number, py: number): { x: number; z: number } => ({
          x: b.minX + (px / EDIT) * w,
          z: b.maxZ - (py / EDIT) * h,
        }),
        rPx: (r: number): number => (r / Math.max(w, h)) * EDIT,
      };
    });

    // ── Painting ─────────────────────────────────────────────────────────
    let raf = 0;
    let lastKey = "";
    function frame(): void {
      raf = requestAnimationFrame(frame);
      const cvs = cvsRef.value;
      const pr = proj.value;
      if (!cvs || !pr) return;
      const key = JSON.stringify([caps.value, selected.value, artImg ? 1 : 0]);
      if (key === lastKey) return;
      lastKey = key;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const px = Math.round(rect.width * dpr);
      if (cvs.width !== px || cvs.height !== px) {
        cvs.width = px;
        cvs.height = px;
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(px / EDIT, 0, 0, px / EDIT, 0, 0);
      ctx.clearRect(0, 0, EDIT, EDIT);
      ctx.fillStyle = "rgba(4, 8, 16, 0.95)";
      ctx.fillRect(0, 0, EDIT, EDIT);
      if (artImg) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(artImg, 0, 0, EDIT, EDIT);
      }
      caps.value.forEach((cap, i) => {
        const c = pr.toPx(cap.at);
        const r = Math.max(3, pr.rPx(cap.radius));
        const color =
          cap.team === "ally" ? "#4ade80" : cap.team === "enemy" ? "#f43f5e" : "rgba(226,232,240,0.9)";
        ctx.strokeStyle = color;
        ctx.lineWidth = i === selected.value ? 2.4 : 1.6;
        ctx.setLineDash(cap.station ? [6, 4] : []);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = "700 14px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(cap.letter, c.x, c.y);
        if (i === selected.value) {
          // Selection halo.
          ctx.strokeStyle = "rgba(0, 195, 255, 0.9)";
          ctx.lineWidth = 1.2;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(c.x, c.y, r + 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      });
    }
    watch(
      () => props.modelValue,
      (open) => {
        cancelAnimationFrame(raf);
        lastKey = "";
        if (open) raf = requestAnimationFrame(frame);
      },
    );
    // The wizard can unmount with the editor still open (route change,
    // modal teardown): the loop must die with the component.
    onBeforeUnmount(() => cancelAnimationFrame(raf));

    // ── Interaction: click to add / select, drag to move ─────────────────
    let drag: { index: number } | null = null;
    function localXY(e: MouseEvent): { x: number; y: number } | null {
      const cvs = cvsRef.value;
      const pr = proj.value;
      if (!cvs || !pr) return null;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return null;
      return {
        x: ((e.clientX - rect.left) / rect.width) * EDIT,
        y: ((e.clientY - rect.top) / rect.height) * EDIT,
      };
    }
    function hitAt(p: { x: number; y: number }): number {
      const pr = proj.value;
      if (!pr) return -1;
      for (let i = caps.value.length - 1; i >= 0; i--) {
        const c = pr.toPx(caps.value[i].at);
        const r = Math.max(10, pr.rPx(caps.value[i].radius));
        if (Math.hypot(p.x - c.x, p.y - c.y) <= Math.max(r, 12)) return i;
      }
      return -1;
    }
    function onDown(e: PointerEvent): void {
      // Right button is the delete gesture (see onContextmenu); middle or
      // other buttons do nothing here.
      if (e.button !== 0) return;
      const cvs = cvsRef.value;
      if (cvs) {
        // Capture keeps the drag alive when the pointer leaves the canvas
        // mid-move (the cap snaps along instead of the drag dying).
        cvs.setPointerCapture(e.pointerId);
      }
      const p = localXY(e);
      if (!p) return;
      const hit = hitAt(p);
      if (hit >= 0) {
        selected.value = hit;
        drag = { index: hit };
        return;
      }
      // Empty water: add a point there (letters re-derive on commit; the
      // in-editor letter is a running letter).
      const pr = proj.value;
      if (!pr) return;
      const w = pr.toWorld(p.x, p.y);
      caps.value = [
        ...caps.value,
        {
          letter: nextLetter(caps.value),
          at: w,
          radius: 115,
          team: null,
        },
      ];
      selected.value = caps.value.length - 1;
    }
    function onMove(e: MouseEvent): void {
      const d = drag;
      if (!d) return;
      const p = localXY(e);
      const pr = proj.value;
      if (!p || !pr) return;
      const w = pr.toWorld(p.x, p.y);
      const cap = caps.value[d.index];
      if (!cap) return;
      caps.value = caps.value.map((c, i) => (i === d.index ? { ...c, at: w } : c));
    }
    function onUp(e: PointerEvent): void {
      const cvs = cvsRef.value;
      if (cvs) {
        try {
          cvs.releasePointerCapture(e.pointerId);
        } catch {
          // Already released (pointercancel path) — nothing to do.
        }
      }
      drag = null;
    }

    /** Right-click on a point deletes it (the hint says so); on empty
     *  water the browser menu is suppressed too — the stage is a surface,
     *  not a text context. */
    function onContextmenu(e: MouseEvent): void {
      e.preventDefault();
      drag = null; // a chorded right-click during a drag must not keep a stale index
      const p = localXY(e);
      if (!p) return;
      const hit = hitAt(p);
      if (hit < 0) return;
      caps.value = caps.value.filter((_, i) => i !== hit);
      if (selected.value === hit) selected.value = -1;
      else if (selected.value > hit) selected.value -= 1;
    }

    function nextLetter(list: CapSpec[]): string {
      const used = new Set(list.map((c) => c.letter));
      for (let i = 0; i < 26; i++) {
        const l = String.fromCharCode(65 + i);
        if (!used.has(l)) return l;
      }
      return "?";
    }

    function patchSelected(patch: Partial<CapSpec>): void {
      if (selected.value < 0) return;
      caps.value = caps.value.map((c, i) => (i === selected.value ? { ...c, ...patch } : c));
    }

    function removeSelected(): void {
      if (selected.value < 0) return;
      caps.value = caps.value.filter((_, i) => i !== selected.value);
      selected.value = -1;
    }

    /** Load one of the retired templates as a starting point. */
    function loadTemplate(presetId: string): void {
      const b = bounds.value;
      const preset = MODE_PRESETS.find((m) => m.id === presetId);
      if (!preset || !b) return;
      caps.value = instantiateCaps(preset, b);
      selected.value = -1;
    }

    /** Manual replay import: pick a .wowsreplay and load its exact caps. */
    async function importFromReplay(): Promise<void> {
      try {
        const paths = await api.pickReplayFiles();
        const path = paths?.[0];
        if (!path) return;
        const layout: LearnedCapLayout | null = await api.getReplayCapLayout(path);
        if (!layout || layout.caps.length === 0) {
          toast.info(i18nT("tactics.cap.importBad"));
          return;
        }
        caps.value = layout.caps.map((c) => ({
          letter: String.fromCharCode(65 + Math.max(0, Math.min(25, c.index))),
          at: { x: c.x, z: c.z },
          radius: c.radius ?? 115,
          // Pre-owned points keep their side (recorder-relative); the
          // author can still flip it on the selected point.
          team:
            c.team != null &&
            layout.recorderTeam != null &&
            (c.team === 0 || c.team === 1)
              ? c.team === layout.recorderTeam
                ? ("ally" as const)
                : ("enemy" as const)
              : null,
          ...(c.appearT != null && c.appearT > 0 ? { appearT: c.appearT } : {}),
          // Station mechanics are not derivable from the layout — the
          // author ticks the checkbox on the selected point.
        }));
        selected.value = -1;
        toast.info(
          i18nT("tactics.cap.imported", { n: layout.caps.length, name: layout.sourceReplay }),
        );
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      }
    }

    function apply(): void {
      emit("apply", caps.value);
      emit("update:modelValue", false);
    }

    const sel = computed<CapSpec | null>(() => caps.value[selected.value] ?? null);

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={i18nT("tactics.cap.title")}
        width="min(58rem, 94vw)"
        footerActions={[
          {
            label: i18nT("tactics.setup.cancel"),
            variant: "secondary",
            onClick: () => emit("update:modelValue", false),
          },
          {
            label: i18nT("tactics.cap.apply"),
            variant: "primary",
            disabled: caps.value.length === 0,
            onClick: apply,
          },
        ]}
      >
        <div class="cap-edit">
          <div class="cap-edit__stage-wrap">
            <canvas
              ref={cvsRef}
              class="cap-edit__stage"
              onPointerdown={onDown}
              onPointermove={onMove}
              onPointerup={onUp}
              onPointercancel={onUp}
              onContextmenu={onContextmenu}
            />
            <p class="cap-edit__hint">{i18nT("tactics.cap.hint")}</p>
            {!bounds.value ? (
              <p class="cap-edit__nobounds">{i18nT("tactics.plan.noBounds")}</p>
            ) : null}
          </div>
          <div class="cap-edit__side">
            <div class="cap-edit__section">{i18nT("tactics.cap.templates")}</div>
            <div class="cap-edit__templates">
              {MODE_PRESETS.map((preset) => {
                const ally = preset.caps.filter((c) => c.team === "ally").length;
                const enemy = preset.caps.filter((c) => c.team === "enemy").length;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    class="cap-edit__tpl"
                    onClick={() => loadTemplate(preset.id)}
                  >
                    {i18nT(`tactics.mode.${preset.labelKey}`)}
                    <span class="cap-edit__tpl-n">{preset.caps.length}</span>
                    <span class="cap-edit__tpl-pre">
                      {ally + enemy > 0
                        ? i18nT("tactics.setup.capsPreownedShort", { ally, enemy })
                        : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <HkButton variant="outline" block onClick={() => void importFromReplay()}>
              <Upload size={13} />
              {i18nT("tactics.cap.importReplay")}
            </HkButton>

            <div class="cap-edit__section">{i18nT("tactics.cap.selected")}</div>
            {sel.value ? (
              <div class="cap-edit__props">
                <HkPopupSelect
                  label={i18nT("tactics.cap.team")}
                  modelValue={sel.value.team ?? "neutral"}
                  options={[
                    { value: "neutral", label: i18nT("tactics.cap.neutral") },
                    { value: "ally", label: i18nT("tactics.cap.ally") },
                    { value: "enemy", label: i18nT("tactics.cap.enemy") },
                  ]}
                  onUpdate:modelValue={(v: string) =>
                    patchSelected({
                      team: v === "ally" ? "ally" : v === "enemy" ? "enemy" : null,
                    })
                  }
                />
                <label class="cap-edit__field">
                  <span>{i18nT("tactics.cap.radius")}</span>
                  <input
                    type="range"
                    min={60}
                    max={220}
                    step={5}
                    value={Math.round(sel.value.radius)}
                    onInput={(e: Event) =>
                      patchSelected({ radius: Number((e.target as HTMLInputElement).value) })
                    }
                  />
                  <b>{Math.round((sel.value.radius * 30) / 100) / 10}km</b>
                </label>
                <label class="cap-edit__field">
                  <span>{i18nT("tactics.cap.station")}</span>
                  <input
                    type="checkbox"
                    checked={sel.value.station === true}
                    onChange={(e: Event) =>
                      patchSelected({ station: (e.target as HTMLInputElement).checked })
                    }
                  />
                </label>
                <HkButton variant="danger" block onClick={removeSelected}>
                  <Crosshair size={13} />
                  {i18nT("tactics.cap.delete")}
                </HkButton>
              </div>
            ) : (
              <p class="cap-edit__none">{i18nT("tactics.cap.none")}</p>
            )}
            <div class="cap-edit__count">
              <HkTag size="sm">{i18nT("tactics.setup.capCount", { n: caps.value.length })}</HkTag>
            </div>
          </div>
        </div>
      </HkModal>
    );
  },
});
