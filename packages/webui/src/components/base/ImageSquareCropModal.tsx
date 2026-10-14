import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from "vue";
import { HkButton, HkModal, HkSlider, useToast, type ModalAction } from "@celestia-island/hikari";
import { FileImage, RefreshCw } from "@lucide/vue";

import { t } from "@/i18n";
import {
  clampOffset,
  coverScale,
  isFullImageRect,
  maxScale,
  viewportSourceRect,
  zoomOffsets,
} from "@/utils/imageCrop";
import "./ImageSquareCropModal.scss";

/** Mirrors commands::stamps' IMAGE_EXTENSIONS (the Rust listing's allowlist)
 *  — anything else can never resolve as a custom image downstream. */
const ACCEPT_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];
const ACCEPT_ATTR = ACCEPT_EXTS.map((e) => `.${e}`).join(",");
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};
/** CSS px edge of the crop viewport (also the logical space the pan/zoom
 *  math is done in — see utils/imageCrop.ts). */
const VIEWPORT_PX = 288;

export interface ImageCropResult {
  bytes: Uint8Array;
  ext: string;
}

/**
 * Generic square-image picker dialog: pick a file → validate its dimensions
 * against min/max side bounds → drag/zoom a square crop over it → confirm
 * emits the crop as PNG bytes (or the ORIGINAL bytes when the picture is
 * already a compliant square — that path preserves GIF animation).
 *
 * Extracted from the seal customizer's needs but kept domain-free on
 * purpose (the shittim-chest avatar-upload modal's business-component
 * pattern): callers pass their own title and size rules and receive bytes
 * over the `confirm` event — how they travel to storage is the caller's
 * business (stamps: the `stamp_import_bytes` raw-IPC command).
 */
export default defineComponent({
  name: "ImageSquareCropModal",
  props: {
    modelValue: { type: Boolean, default: false },
    /** Dialog title — caller-owned (e.g. the seal customizer's wording). */
    title: { type: String, required: true },
    /** Source-side dimension bounds: shorter side below min / any side
     *  above max rejects the file outright. */
    minSide: { type: Number, default: 100 },
    maxSide: { type: Number, default: 4096 },
    /** Exported square's edge cap — larger crops are downscaled to it. */
    exportCap: { type: Number, default: 512 },
    /** Original bytes pass through unchanged only when they are a compliant
     *  square AND under this size (canvas re-encode costs animation). */
    passthroughMaxBytes: { type: Number, default: 2 * 1024 * 1024 },
    /** Decode-side sanity cap on the picked file. */
    maxFileBytes: { type: Number, default: 16 * 1024 * 1024 },
    /** Live-preview edge lengths (px) beside the crop viewport. */
    previewSizes: { type: Array as PropType<number[]>, default: () => [64, 40] },
    /** Extra CSS transform for the previews (e.g. the seals' −9° press). */
    previewTransform: { type: String, default: "" },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    confirm: (_result: ImageCropResult) => true,
  },
  setup(props, { emit }) {
    const toast = useToast();
    const fileInput = ref<HTMLInputElement | null>(null);
    const viewportEl = ref<HTMLElement | null>(null);

    // Picked-file state. `imgEl` is deliberately non-reactive (a plain
    // let) — the render only needs the dimensions/URL below.
    let imgEl: HTMLImageElement | null = null;
    let rawBytes: Uint8Array | null = null;
    let rawExt = "png";
    const objectUrl = ref("");
    const srcW = ref(0);
    const srcH = ref(0);
    const error = ref("");

    // Pan/zoom state (see utils/imageCrop.ts for the coordinate model).
    const scale = ref(1);
    const tx = ref(0);
    const ty = ref(0);
    const exporting = ref(false);
    let drag: { id: number; x: number; y: number; tx: number; ty: number } | null = null;

    // Guards pickFile's async continuations against a newer pick (the
    // refreshSequence pattern from stores/stampOverrides): a slow decode
    // finishing after a faster re-pick must neither clobber the newer
    // state nor ship the older file's bytes through the passthrough.
    // resetPick bumps it too, so a decode pending across close+reopen
    // can't commit into the fresh dialog.
    let pickSequence = 0;

    const viewport = () => viewportEl.value?.clientWidth || VIEWPORT_PX;
    const cover = computed(() => coverScale(srcW.value, srcH.value, viewport()));
    const zoomCeil = computed(() =>
      maxScale(srcW.value, srcH.value, viewport(), props.minSide),
    );
    /** Slider value: zoom relative to cover-fit (1 = whole compliant
     *  square / widest cover of a non-square). */
    const zoom = computed(() => scale.value / cover.value);
    const zoomCeilRelative = computed(() => zoomCeil.value / cover.value);
    const hasImage = computed(() => srcW.value > 0 && srcH.value > 0);

    function releaseObjectUrl() {
      if (objectUrl.value) {
        URL.revokeObjectURL(objectUrl.value);
        objectUrl.value = "";
      }
    }

    function resetPick() {
      pickSequence += 1;
      releaseObjectUrl();
      imgEl = null;
      rawBytes = null;
      srcW.value = 0;
      srcH.value = 0;
      scale.value = 1;
      tx.value = 0;
      ty.value = 0;
      error.value = "";
    }

    watch(
      () => props.modelValue,
      (open) => {
        // Fresh pick on every open — the AvatarUploadModal pattern: stale
        // leftovers from a previous session must not flash in the viewport.
        if (open) resetPick();
      },
    );
    onBeforeUnmount(releaseObjectUrl);


    async function pickFile(file: File | null | undefined) {
      const sequence = ++pickSequence;
      // Any rejected pick empties the stage — one rule, and a disabled
      // confirm always means "no valid image is staged".
      const reject = (key: string, params?: Record<string, unknown>) => {
        resetPick();
        error.value = t(`common.imageCrop.${key}`, params);
      };
      if (!file) return;
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      const byMime = MIME_TO_EXT[file.type];
      if (!ACCEPT_EXTS.includes(ext) || (byMime && !ACCEPT_EXTS.includes(byMime))) {
        reject("unsupported");
        return;
      }
      if (file.size > props.maxFileBytes) {
        reject("fileTooLarge");
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        if (sequence !== pickSequence) return;
        const bytes = new Uint8Array(buffer);
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
        } catch (e) {
          // The blob URL never became component state — revoke it here or
          // every failed decode leaks one.
          URL.revokeObjectURL(url);
          throw e;
        }
        if (sequence !== pickSequence) {
          URL.revokeObjectURL(url);
          return;
        }
        const shorter = Math.min(img.naturalWidth, img.naturalHeight);
        if (shorter < props.minSide) {
          // Keep the picture visible (the user sees how it fails) but flag
          // it — confirm stays disabled via the error gate below.
          releaseObjectUrl();
          imgEl = img;
          objectUrl.value = url;
          rawBytes = bytes;
          rawExt = byMime && ACCEPT_EXTS.includes(byMime) ? byMime : ext || "png";
          srcW.value = img.naturalWidth;
          srcH.value = img.naturalHeight;
          scale.value = coverScale(srcW.value, srcH.value, viewport());
          tx.value = 0;
          ty.value = 0;
          error.value = t("common.imageCrop.tooSmall", { min: props.minSide });
          return;
        }
        if (Math.max(img.naturalWidth, img.naturalHeight) > props.maxSide) {
          URL.revokeObjectURL(url);
          reject("tooLarge", { max: props.maxSide });
          return;
        }
        releaseObjectUrl();
        imgEl = img;
        objectUrl.value = url;
        rawBytes = bytes;
        rawExt = byMime && ACCEPT_EXTS.includes(byMime) ? byMime : ext || "png";
        srcW.value = img.naturalWidth;
        srcH.value = img.naturalHeight;
        scale.value = coverScale(srcW.value, srcH.value, viewport());
        tx.value = 0;
        ty.value = 0;
      } catch {
        if (sequence !== pickSequence) return;
        reject("decodeFailed");
      }
    }

    function applyZoom(factor: number) {
      if (!hasImage.value) return;
      const next = Math.min(zoomCeil.value, Math.max(cover.value, scale.value * factor));
      const actual = next / scale.value;
      if (actual === 1) return;
      const moved = zoomOffsets(tx.value, ty.value, actual);
      scale.value = next;
      tx.value = clampOffset(moved.tx, srcW.value * next, viewport());
      ty.value = clampOffset(moved.ty, srcH.value * next, viewport());
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      applyZoom(Math.exp(-e.deltaY * 0.0015));
    }

    function onPointerDown(e: PointerEvent) {
      if (!hasImage.value) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
      if (!drag || drag.id !== e.pointerId) return;
      const vp = viewport();
      tx.value = clampOffset(drag.tx + (e.clientX - drag.x), srcW.value * scale.value, vp);
      ty.value = clampOffset(drag.ty + (e.clientY - drag.y), srcH.value * scale.value, vp);
    }

    function onPointerUp(e: PointerEvent) {
      if (drag?.id === e.pointerId) drag = null;
    }

    function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
      return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), type);
      });
    }

    async function confirm() {
      if (!hasImage.value || error.value || exporting.value || !imgEl) return;
      exporting.value = true;
      try {
        const vp = viewport();
        const rect = viewportSourceRect(srcW.value, srcH.value, vp, scale.value, tx.value, ty.value);
        if (
          rawBytes &&
          rawBytes.byteLength <= props.passthroughMaxBytes &&
          isFullImageRect(rect, srcW.value, srcH.value)
        ) {
          // Already a compliant square: ship the original bytes untouched —
          // no generation loss, and a GIF keeps its animation.
          emit("confirm", { bytes: rawBytes, ext: rawExt });
          emit("update:modelValue", false);
          return;
        }
        const out = Math.max(1, Math.round(Math.min(rect.size, props.exportCap)));
        const canvas = document.createElement("canvas");
        canvas.width = out;
        canvas.height = out;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d unavailable");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(imgEl, rect.x, rect.y, rect.size, rect.size, 0, 0, out, out);
        const blob = await canvasToBlob(canvas, "image/png");
        emit("confirm", { bytes: new Uint8Array(await blob.arrayBuffer()), ext: "png" });
        emit("update:modelValue", false);
      } catch (e) {
        toast.error(`${t("common.imageCrop.exportFailed")}\n${(e as Error).message || e}`);
      } finally {
        exporting.value = false;
      }
    }

    /** One preview tile: the same source rect the viewport shows, rescaled
     *  into a `size`-px square (all viewport-space quantities multiplied by
     *  size/vp), with the caller's tilt applied around the tile. */
    function previewStyle(size: number): Record<string, string> {
      const vp = viewport();
      const k = size / vp;
      const w = srcW.value * scale.value * k;
      const h = srcH.value * scale.value * k;
      return {
        width: `${w}px`,
        height: `${h}px`,
        left: `${(size - w) / 2 + tx.value * k}px`,
        top: `${(size - h) / 2 + ty.value * k}px`,
      };
    }

    const imageStyle = computed(() => ({
      width: `${srcW.value * scale.value}px`,
      height: `${srcH.value * scale.value}px`,
      left: `${(viewport() - srcW.value * scale.value) / 2 + tx.value}px`,
      top: `${(viewport() - srcH.value * scale.value) / 2 + ty.value}px`,
    }));

    const actions = computed<ModalAction[]>(() => [
      {
        label: t("common.imageCrop.cancel"),
        variant: "ghost",
        onClick: () => emit("update:modelValue", false),
      },
      {
        label: t("common.imageCrop.confirm"),
        variant: "primary",
        loading: exporting.value,
        disabled: !hasImage.value || !!error.value,
        onClick: () => void confirm(),
      },
    ]);

    return () => (
      <HkModal
        modelValue={props.modelValue}
        title={props.title}
        width="sm"
        footerActions={actions.value}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
      >
        <div class="image-crop">
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT_ATTR}
            style="display:none"
            onChange={(e: Event) => {
              const input = e.target as HTMLInputElement;
              void pickFile(input.files?.[0]);
              input.value = "";
            }}
          />
          {!hasImage.value ? (
            <div class="image-crop__empty">
              <HkButton variant="secondary" onClick={() => fileInput.value?.click()}>
                <FileImage size={14} /> {t("common.imageCrop.choose")}
              </HkButton>
              <p class="image-crop__hint">
                {t("common.imageCrop.requirement", {
                  min: props.minSide,
                  max: props.maxSide,
                })}
              </p>
            </div>
          ) : (
            <>
              <div class="image-crop__stage">
                <div
                  ref={viewportEl}
                  class="image-crop__viewport"
                  style={{ width: `${VIEWPORT_PX}px`, height: `${VIEWPORT_PX}px` }}
                  onWheel={onWheel}
                  onPointerdown={onPointerDown}
                  onPointermove={onPointerMove}
                  onPointerup={onPointerUp}
                  onPointercancel={onPointerUp}
                >
                  <img class="image-crop__canvas-img" src={objectUrl.value} style={imageStyle.value} alt="" draggable={false} />
                </div>
                <div class="image-crop__side">
                  <div class="image-crop__previews">
                    {props.previewSizes.map((size) => (
                      <span
                        class="image-crop__preview"
                        key={size}
                        style={{
                          width: `${size}px`,
                          height: `${size}px`,
                          transform: props.previewTransform || undefined,
                        }}
                      >
                        <img class="image-crop__canvas-img" src={objectUrl.value} style={previewStyle(size)} alt="" draggable={false} />
                      </span>
                    ))}
                  </div>
                  <HkSlider
                    min={1}
                    max={zoomCeilRelative.value}
                    step={0.01}
                    modelValue={zoom.value}
                    ariaLabel={t("common.imageCrop.zoom")}
                    formatValue={(v: number) => `${Math.round(v * 100)}%`}
                    onUpdate:modelValue={(v: number) => {
                      const factor = (v * cover.value) / scale.value;
                      applyZoom(factor);
                    }}
                  />
                  <p class="image-crop__meta">
                    {t("common.imageCrop.dims", {
                      w: srcW.value,
                      h: srcH.value,
                      out: Math.round(Math.min(viewport() / scale.value, props.exportCap)),
                    })}
                  </p>
                  <HkButton variant="ghost" size="sm" onClick={() => fileInput.value?.click()}>
                    <RefreshCw size={13} /> {t("common.imageCrop.rechoose")}
                  </HkButton>
                </div>
              </div>
              <p class="image-crop__hint">{t("common.imageCrop.dragHint")}</p>
            </>
          )}
          {error.value && <p class="image-crop__error">{error.value}</p>}
        </div>
      </HkModal>
    );
  },
});
