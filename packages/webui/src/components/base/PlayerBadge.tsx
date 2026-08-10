import { computed, defineComponent } from "vue";
import type { DogTag } from "@/api";
import dogtagsMapRaw from "@/data/dogtags_map.json";

import "./PlayerBadge.scss";

/** dogtags_map.json: vortex dogTag id → [index, species, colorHEX?]. */
type MapEntry = [string, string] | [string, string, string];
const MAP = dogtagsMapRaw as Record<string, MapEntry>;

function entryFor(id: number | undefined | null): MapEntry | null {
  if (id == null) return null;
  return MAP[String(id)] ?? null;
}

function hex(hexWithPrefix: string): string {
  return hexWithPrefix.replace("0x", "#");
}

/** Image URL for a dogtag part. BackgroundShape entries are directories
 *  (border.png = the plate frame); everything else is a flat PNG. */
function partUrl(entry: MapEntry): string {
  const [index, species] = entry;
  if (species === "BackgroundShape") return `/dogtags/${index}/border.png`;
  return `/dogtags/${index}.png`;
}

/**
 * Player emblem badge — the player's real in-game dog tag, layered exactly
 * like the client: background color fill → background-texture pattern →
 * background-shape frame → center symbol, all resolved from the game's own
 * GameParams dogtag table (dogtags_map.json) with the extracted GUI art.
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
      return {
        bg: bgColor?.[2] ? hex(bgColor[2]) : "rgba(90, 100, 115, 0.9)",
        border: borderColor?.[2] ? hex(borderColor[2]) : null,
        shapeUrl: shape ? partUrl(shape) : null,
        textureUrl: texture ? partUrl(texture) : null,
        symbolUrl: symbol ? partUrl(symbol) : null,
      };
    });

    return () => (
      <div
        class={[
          "player-badge",
          layers.value ? "player-badge--dogtag" : tierClass.value,
        ]}
        style={{ width: `${props.size}px`, height: `${props.size}px` }}
        title={layers.value ? `Player emblem (Tier ${props.tier})` : `Service record tier ${props.tier}`}
      >
        {layers.value ? (
          <span class="player-badge__dt" style={{ background: layers.value.bg }}>
            {layers.value.textureUrl ? (
              <img class="player-badge__dt-texture" src={layers.value.textureUrl} alt="" />
            ) : null}
            {layers.value.symbolUrl ? (
              <img class="player-badge__dt-symbol" src={layers.value.symbolUrl} alt="" />
            ) : (
              <span class="player-badge__tier">{props.tier || "?"}</span>
            )}
            {layers.value.shapeUrl ? (
              <img
                class="player-badge__dt-frame"
                src={layers.value.shapeUrl}
                alt=""
                style={layers.value.border ? { filter: `drop-shadow(0 0 1px ${layers.value.border})` } : undefined}
              />
            ) : null}
          </span>
        ) : (
          <span class="player-badge__tier">{props.tier || "?"}</span>
        )}
      </div>
    );
  },
});
