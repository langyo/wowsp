import { computed, defineComponent } from "vue";
import type { DogTag } from "@/api";
import dogtagsMapRaw from "@/data/dogtags_map.json";

import "./PlayerBadge.scss";

/** dogtags_map.json: vortex dogTag id -> [index, species, colorHEX?]. */
type MapEntry = [string, string] | [string, string, string];
const MAP = dogtagsMapRaw as Record<string, MapEntry>;

function entryFor(id: number | undefined | null): MapEntry | null {
  if (id == null) return null;
  return MAP[String(id)] ?? null;
}

function hex(hexWithPrefix: string): string {
  return hexWithPrefix.replace("0x", "#");
}

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

/** Image URL for a dog tag part (symbol/texture). */
function partUrl(index: string): string {
  return "/dogtags/" + index + ".png";
}

/**
 * Player emblem badge - the player real in-game dog tag. Layers (bottom to
 * top): background color fill, flat plate (when present), texture pattern,
 * center symbol, then the border outline. The color fill and texture are
 * clipped to the plate shape so they never spill past its border.
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
      if (!dt) return null;
      const bgColor = entryFor(dt.backgroundColor);
      const borderColor = entryFor(dt.borderColor);
      const shape = entryFor(dt.backgroundId);
      const texture = entryFor(dt.textureId);
      const symbol = entryFor(dt.symbolId);
      // Need at least the symbol or the shape to look like a dog tag.
      if (!symbol && !shape) return null;

      const outline = shape ? isOutlineShape(shape[0]) : false;
      const shapeIndex = shape ? shape[0] : "";
      return {
        bg: bgColor?.[2] ? hex(bgColor[2]) : null,
        border: borderColor?.[2] ? hex(borderColor[2]) : null,
        // Flat shapes are the plate (bottom layer); directory shapes only
        // contribute a border outline (top layer).
        plateUrl: shape && !outline ? "/dogtags/" + shapeIndex + ".png" : null,
        frameUrl: shape && outline ? "/dogtags/" + shapeIndex + "/border.png" : null,
        // Clip mask = the plate filled shape: the flat plate alpha, or the
        // filled shield shipped next to the outline for directory shapes.
        maskUrl: shape
          ? outline
            ? "/dogtags/" + shapeIndex + "/PCNT001.png"
            : "/dogtags/" + shapeIndex + ".png"
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
          ]}
          style={{ width: props.size + "px", height: props.size + "px" }}
          title={l ? "Player emblem (Tier " + props.tier + ")" : "Service record tier " + props.tier}
        >
          {l ? (
            <span class="player-badge__dt">
              <span class="player-badge__clip" style={clipStyle}>
                {l.plateUrl ? (
                  <img class="player-badge__dt-plate" src={l.plateUrl} alt="" />
                ) : null}
                {l.textureUrl ? (
                  <img class="player-badge__dt-texture" src={l.textureUrl} alt="" />
                ) : null}
                {l.symbolUrl ? (
                  <img class="player-badge__dt-symbol" src={l.symbolUrl} alt="" />
                ) : (
                  <span class="player-badge__tier">{props.tier || "?"}</span>
                )}
              </span>
              {l.frameUrl ? (
                <img
                  class="player-badge__dt-frame"
                  src={l.frameUrl}
                  alt=""
                  style={l.border ? { filter: "drop-shadow(0 0 1px " + l.border + ")" } : undefined}
                />
              ) : null}
            </span>
          ) : (
            <span class="player-badge__tier">{props.tier || "?"}</span>
          )}
        </div>
      );
    };
  },
});
