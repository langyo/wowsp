/**
 * Battle-icon component — the DOM face of the project's ONE ship/aircraft
 * class-glyph provider (the canvas faces preload and draw the same art
 * through `shipIcons.ts`'s `shipIconUrl()`, so every surface shows
 * identical art at every size).
 *
 * - Ships: traced SVG of the game's OWN HUD markers
 *   (`/gui/battle_hud/markers/ship/icon_{variant}_{class}.png`), served
 *   from `res/images/ships/icon_*.svg`. The art was vectorised by
 *   `scripts/model_convert/trace_class_icons.py` because the 27 px bitmap
 *   upscaled into jagged stair-steps at modern display densities (user
 *   feedback); the vector face renders crisp at ANY size and DPR.
 * - Planes: `/gui/battle_hud/markers/plane/...` art via `planeIcon()`.
 *
 * Variants follow the battle HUD: ally (green), enemy (red), white
 * (neutral), sunk (dim grey), plain (uncolored class icon).
 */
import { defineComponent, computed } from "vue";

import { shipIconUrl } from "@/features/holographic/shipIcons";
import type { ShipIconVariant } from "@/features/holographic/shipIcons";
import planeIcon from "@/features/holographic/planeIcons";

export default defineComponent({
  name: "BattleIcon",
  props: {
    /** WG ShipInfo.type for kind="ship", plane type name for kind="plane". */
    type: { type: String, required: true },
    kind: { type: String as () => "ship" | "plane", default: "ship" },
    variant: {
      type: String as () => ShipIconVariant,
      default: "plain",
    },
    size: { type: Number, default: 14 },
  },
  setup(props) {
    const url = computed(() =>
      props.kind === "ship" ? shipIconUrl(props.type, props.variant) : null,
    );
    return () => {
      if (props.kind === "plane") {
        const img = planeIcon(props.type);
        return (
          <img
            src={img?.src}
            width={props.size}
            height={props.size}
            alt=""
            draggable={false}
            decoding="sync"
          />
        );
      }
      if (url.value) {
        return (
          <img
            src={url.value}
            width={props.size}
            height={props.size}
            alt=""
            draggable={false}
            decoding="sync"
          />
        );
      }
      return <span style={{ width: `${props.size}px`, height: `${props.size}px` }} />;
    };
  },
});
