import { computed, defineComponent } from "vue";
import type { DogTag } from "@/api";

import { AssetImage } from "@/components/base/AssetImage";
import { dogtagAssetUrl, dogtagEntry } from "@/utils/dogtagAssets";
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
 * BackgroundShape assets ship in two layouts:
 *   - PCNA001..PCNA009: a per-shape directory. "border.png" is the plate
 *     outline (interior transparent) drawn on top; "PCNT001.png" in the same
 *     directory is the filled shield used as the clip mask.
 *   - everything else (PCNA037+, PCNA999): a single flat plate image whose
 *     own alpha is both the plate and the clip mask.
 * Every part is an 80x80 canvas, so all layers stack at one scale.
 */
function isOutlineShape(index: string): boolean {
  const n = Number(index.slice(4));
  return n >= 1 && n <= 9;
}

/** Image URL for a dog tag part (symbol/texture), pack-aware. */
function partUrl(index: string): string {
  return dogtagAssetUrl(index + ".png");
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
 * Falls back to the service-record tier badge when no dog tag is available.
 */
export default defineComponent({
  name: "PlayerBadge",
  props: {
    tier: { type: Number, default: 0 },
    dogTag: { type: Object as () => DogTag | null, default: null },
    size: { type: Number, default: 48 },
  },
  setup(props) {
    const tierClass = computed(() => {
      if (props.tier >= 76) return "badge-diamond";
      if (props.tier >= 51) return "badge-platinum";
      if (props.tier >= 26) return "badge-gold";
      if (props.tier >= 11) return "badge-silver";
      return "badge-bronze";
    });

    const layers = computed(() => {
      const dt = props.dogTag;
      // When Vortex returns no dog tag (accounts that never customised), fall
      // back to the default symbol + shield so the badge renders a dog tag
      // instead of the service-record tier. Lookups go through the
      // pack-overlay store so medals added after this build was cut resolve.
      const bgColor = dogtagEntry(dt?.backgroundColor);
      const borderColor = dogtagEntry(dt?.borderColor);
      const shape = dogtagEntry(dt?.backgroundId) ?? dogtagEntry(DEFAULT_SHAPE_ID);
      const texture = dogtagEntry(dt?.textureId);
      const symbol = dogtagEntry(dt?.symbolId) ?? dogtagEntry(DEFAULT_SYMBOL_ID);

      // Standalone medal: one full-bleed image, nothing else stacks.
      if (symbol && STANDALONE_SPECIES.has(symbol[1])) {
        return {
          standalone: true,
          bg: null,
          border: null,
          plateUrl: null,
          frameUrl: null,
          maskUrl: null,
          textureUrl: null,
          symbolUrl: partUrl(symbol[0]),
        };
      }

      const outline = shape ? isOutlineShape(shape[0]) : false;
      const shapeIndex = shape ? shape[0] : "";
      return {
        standalone: false,
        bg: bgColor?.[2] ? hex(bgColor[2]) : null,
        border: borderColor?.[2] ? hex(borderColor[2]) : null,
        // Flat shapes are the plate (bottom layer); directory shapes only
        // contribute a border outline (top layer).
        plateUrl: shape && !outline ? dogtagAssetUrl(shapeIndex + ".png") : null,
        frameUrl: shape && outline ? dogtagAssetUrl(shapeIndex + "/border.png") : null,
        // Clip mask = the plate filled shape: the flat plate alpha, or the
        // filled shield shipped next to the outline for directory shapes.
        maskUrl: shape
          ? outline
            ? dogtagAssetUrl(shapeIndex + "/PCNT001.png")
            : dogtagAssetUrl(shapeIndex + ".png")
          : null,
        textureUrl: texture ? partUrl(texture[0]) : null,
        symbolUrl: symbol ? partUrl(symbol[0]) : null,
      };
    });

    return () => {
      const l = layers.value;
      const clipStyle: Record<string, string> = {
        background: l?.bg ?? "rgba(90, 100, 115, 0.9)",
      };
      if (l?.maskUrl) {
        clipStyle.WebkitMaskImage = "url(" + l.maskUrl + ")";
        clipStyle.maskImage = "url(" + l.maskUrl + ")";
        clipStyle.WebkitMaskSize = "100% 100%";
        clipStyle.maskSize = "100% 100%";
        clipStyle.WebkitMaskRepeat = "no-repeat";
        clipStyle.maskRepeat = "no-repeat";
      }

      return (
        <div
          class={[
            "player-badge",
            l ? "player-badge--dogtag" : tierClass.value,
            l?.standalone ? "player-badge--medal" : null,
          ]}
          style={{ width: props.size + "px", height: props.size + "px" }}
          data-hint={l ? "Player emblem (Tier " + props.tier + ")" : "Service record tier " + props.tier}
        >
          {l ? (
            l.standalone ? (
              <span class="player-badge__dt">
                <AssetImage
                  class="player-badge__dt-symbol"
                  src={l.symbolUrl}
                  alt=""
                  fallback={<span class="player-badge__tier">{props.tier || "?"}</span>}
                />
              </span>
            ) : (
              <span class="player-badge__dt">
                <span class="player-badge__clip" style={clipStyle}>
                  <AssetImage class="player-badge__dt-plate" src={l.plateUrl} alt="" />
                  <AssetImage class="player-badge__dt-texture" src={l.textureUrl} alt="" />
                  <AssetImage
                    class="player-badge__dt-symbol"
                    src={l.symbolUrl}
                    alt=""
                    fallback={<span class="player-badge__tier">{props.tier || "?"}</span>}
                  />
                </span>
                <AssetImage
                  class="player-badge__dt-frame"
                  src={l.frameUrl}
                  alt=""
                  style={l.border ? { filter: "drop-shadow(0 0 1px " + l.border + ")" } : undefined}
                />
              </span>
            )
          ) : (
            <span class="player-badge__tier">{props.tier || "?"}</span>
          )}
        </div>
      );
    };
  },
});
