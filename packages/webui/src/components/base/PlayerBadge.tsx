import { computed, defineComponent, ref, watch, watchEffect, type PropType } from "vue";
import type { DogTag } from "@/api";

import { AssetImage } from "@/components/base/AssetImage";
import { dogtagAssetUrl, dogtagEntry, dogtagUrlChain } from "@/utils/dogtagAssets";
import "./PlayerBadge.scss";

function hex(hexWithPrefix: string): string {
  return hexWithPrefix.replace("0x", "#");
}

// Default emblem parts (PCNB999 symbol + PCNA999 shield). Vortex omits the
// symbol/background ids for accounts that never customised their emblem, so
// fall back to these so the badge still renders a dog tag.
const DEFAULT_SYMBOL_ID = 3247393712;
const DEFAULT_SHAPE_ID = 3247426480;

/**
 * Part indexes that failed to load from EVERY candidate URL (see
 * dogtagUrlChain) — "PCNA037", "PCNA001/PCNT001". Consumers consult this
 * set to pick a degraded shape (drop the layer, clip the fill to a plain
 * circle) instead of showing nothing. Replaced wholesale so the ref fires.
 */
const missingParts = ref(new Set<string>());

function markPartMissing(key: string): void {
  if (missingParts.value.has(key)) return;
  const next = new Set(missingParts.value);
  next.add(key);
  missingParts.value = next;
}

/**
 * Mask part → the chain candidate that actually paints. A CSS mask whose
 * URL 404s hides the whole clip group with NO error event to react to, and
 * a legacy all-.png pack cache would 404 every .webp mask for good — so
 * the probe below resolves each mask's first working candidate and the
 * clip style follows it.
 */
const maskUrls = ref(new Map<string, string>());

function setResolvedMask(key: string, url: string): void {
  if (maskUrls.value.get(key) === url) return;
  const next = new Map(maskUrls.value);
  next.set(key, url);
  maskUrls.value = next;
}

/**
 * One badge part rendered through its URL chain: the first candidate that
 * paints wins, a fresh load error steps to the next, and an exhausted
 * chain marks the part missing. (AssetImage only reports loading → error
 * transitions, so a retried URL never double-fires.)
 */
const PartImage = defineComponent({
  name: "DogtagPartImage",
  props: {
    index: { type: String, required: true },
    partClass: { type: String, required: true },
    partStyle: { type: Object as PropType<Record<string, string> | undefined>, default: undefined },
  },
  setup(props) {
    const attempt = ref(0);
    const urls = computed(() => dogtagUrlChain(props.index + ".webp"));
    // A fresh chain (the pack wiring in, the map overlay resolving a new
    // index) restarts from its best candidate.
    watch(urls, () => {
      attempt.value = 0;
    });
    return () => (
      <AssetImage
        class={props.partClass}
        style={props.partStyle}
        src={urls.value[attempt.value] ?? null}
        alt=""
        onError={() => {
          if (attempt.value < urls.value.length - 1) attempt.value += 1;
          else markPartMissing(props.index);
        }}
      />
    );
  },
});

/**
 * BackgroundShape assets ship in two layouts:
 *   - PCNA001..PCNA009: a per-shape directory. "border" is the plate
 *     outline (interior transparent) drawn on top; "PCNT001" in the same
 *     directory is the filled shield used as the clip mask.
 *   - everything else (PCNA037+, PCNA999): a single flat plate image whose
 *     own alpha is both the plate and the clip mask.
 * Every part is an 80x80 canvas, so all layers stack at one scale.
 */
function isOutlineShape(index: string): boolean {
  const n = Number(index.slice(4));
  return n >= 1 && n <= 9;
}

/** Patch (PCNP) and unique-emblem (PCNU) species ship as complete medals on
 *  their own 80x80 canvas. The game renders them as the whole avatar — they
 *  never stack onto a custom dog tag — so they must bypass the assembled
 *  plate/color/texture pipeline. Vortex carries them in symbol_id with every
 *  other dog_tag field zeroed. */
const STANDALONE_SPECIES = new Set(["Patch", "Emblem"]);

/**
 * Player emblem badge - the player real in-game avatar. Two shapes:
 *   - standalone medal: the symbol entry is a Patch/Emblem species; the
 *     artwork is drawn as-is, with no plate, colors or frame behind it.
 *   - custom dog tag: layers (bottom to top) background color fill, flat
 *     plate (when present), texture pattern, center symbol, then the border
 *     outline. The color fill and texture are clipped to the plate shape so
 *     they never spill past its border.
 *
 * Parts that cannot load from anywhere drop out individually; a missing
 * clip mask degrades the fill to a plain circle. Nothing identifying is
 * composited on top — deliberately no service-record tier number (at badge
 * sizes it read like a permission rank; see the sidebar footer's
 * AccountAvatar for the same policy).
 */
export default defineComponent({
  name: "PlayerBadge",
  props: {
    dogTag: { type: Object as () => DogTag | null, default: null },
    size: { type: Number, default: 48 },
  },
  setup(props) {
    const layers = computed(() => {
      const dt = props.dogTag;
      // When Vortex returns no dog tag (accounts that never customised), fall
      // back to the default symbol + shield so the badge renders a dog tag
      // instead of an empty disc. Lookups go through the pack-overlay store
      // so medals added after this build was cut resolve.
      const bgColor = dogtagEntry(dt?.backgroundColor);
      const borderColor = dogtagEntry(dt?.borderColor);
      const shape = dogtagEntry(dt?.backgroundId) ?? dogtagEntry(DEFAULT_SHAPE_ID);
      const texture = dogtagEntry(dt?.textureId);
      const symbol = dogtagEntry(dt?.symbolId) ?? dogtagEntry(DEFAULT_SYMBOL_ID);

      // Standalone medal: one full-bleed image, nothing else stacks.
      if (symbol && STANDALONE_SPECIES.has(symbol[1])) {
        return {
          standalone: true as const,
          bg: null,
          border: null,
          shapeIndex: null,
          maskUrl: null,
          /** Standalone medals have no clip group — nothing to probe. */
          maskProbeKey: null as string | null,
          maskKey: null as string | null,
          textureIndex: texture ? texture[0] : null,
          symbolIndex: symbol[0],
        };
      }

      const outline = shape ? isOutlineShape(shape[0]) : false;
      const shapeIndex = shape ? shape[0] : "";
      const maskKey = outline ? shapeIndex + "/PCNT001" : shapeIndex;
      return {
        standalone: false as const,
        outline,
        bg: bgColor?.[2] ? hex(bgColor[2]) : null,
        border: borderColor?.[2] ? hex(borderColor[2]) : null,
        // Flat shapes are the plate (bottom layer); directory shapes only
        // contribute a border outline (top layer).
        shapeIndex,
        // Clip mask = the plate filled shape: the flat plate alpha, or the
        // filled shield shipped next to the outline for directory shapes.
        // Best-candidate URL; the probe below may resolve a later chain
        // link (a legacy all-.png pack serves PNG masks).
        maskUrl: shape ? dogtagAssetUrl(maskKey + ".webp") : null,
        // Every mask is probed — a CSS mask fails silently, so nothing
        // else would resolve or flag it.
        maskProbeKey: maskKey,
        maskKey,
        textureIndex: texture ? texture[0] : null,
        symbolIndex: symbol ? symbol[0] : "",
      };
    });

    // Probe masks (see layers): walk the URL chain with one-shot Image
    // loads, remember the first candidate that paints, and mark the part
    // missing only when every candidate fails.
    watchEffect(() => {
      const l = layers.value;
      const key = l?.maskProbeKey;
      if (l == null || l.standalone || key == null) return;
      const urls = dogtagUrlChain(key + ".webp");
      const probe = (i: number): void => {
        const im = new Image();
        im.onload = () => setResolvedMask(key, urls[i]);
        im.onerror = () => {
          if (i + 1 < urls.length) probe(i + 1);
          else markPartMissing(key);
        };
        im.src = urls[i];
      };
      probe(0);
    });

    return () => {
      const l = layers.value;
      const maskMissing = l?.maskKey != null && missingParts.value.has(l.maskKey);
      const maskSrc =
        l?.maskKey != null ? maskUrls.value.get(l.maskKey) ?? l.maskUrl : null;
      const clipStyle: Record<string, string> = {
        background: l?.bg ?? "rgba(90, 100, 115, 0.9)",
      };
      if (maskSrc && !maskMissing) {
        clipStyle.WebkitMaskImage = "url(" + maskSrc + ")";
        clipStyle.maskImage = "url(" + maskSrc + ")";
        clipStyle.WebkitMaskSize = "100% 100%";
        clipStyle.maskSize = "100% 100%";
        clipStyle.WebkitMaskRepeat = "no-repeat";
        clipStyle.maskRepeat = "no-repeat";
      } else {
        // Mask gone (or never resolvable): a failed CSS mask would hide the
        // fill entirely, so clip to a plain circle instead and drop the
        // texture that would now paint past the plate shape. The overflow
        // keeps the square symbol artwork inside the circle.
        clipStyle.borderRadius = "50%";
        clipStyle.overflow = "hidden";
      }

      return (
        <div
          class={["player-badge", "player-badge--dogtag", l?.standalone ? "player-badge--medal" : null]}
          style={{ width: props.size + "px", height: props.size + "px" }}
          data-hint="Player emblem"
        >
          {l?.standalone ? (
            <span class="player-badge__dt">
              <PartImage index={l.symbolIndex} partClass="player-badge__dt-symbol" />
            </span>
          ) : (
            <span class="player-badge__dt">
              <span class="player-badge__clip" style={clipStyle}>
                {/* Flat shapes only: directory shapes have no flat plate
                    file (their plate is the masked fill + border outline). */}
                {l?.shapeIndex && !l.outline && !maskMissing ? (
                  <PartImage index={l.shapeIndex} partClass="player-badge__dt-plate" />
                ) : null}
                {l?.textureIndex && !maskMissing ? (
                  <PartImage index={l.textureIndex} partClass="player-badge__dt-texture" />
                ) : null}
                <PartImage index={l?.symbolIndex ?? ""} partClass="player-badge__dt-symbol" />
              </span>
              {l?.outline ? (
                <PartImage
                  index={l.shapeIndex + "/border"}
                  partClass="player-badge__dt-frame"
                  partStyle={l.border ? { filter: "drop-shadow(0 0 1px " + l.border + ")" } : undefined}
                />
              ) : null}
            </span>
          )}
        </div>
      );
    };
  },
});
