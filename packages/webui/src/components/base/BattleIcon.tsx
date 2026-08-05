/**
 * Battle-icon component: the game's OWN HUD markers, used everywhere a
 * ship/aircraft type glyph is needed (hologram labels, minimap, scorebar).
 *
 * - Ships: `/gui/battle_hud/markers/ship/icon_{variant}_{class}.png`
 *   (original game art, see features/holographic/shipIcons.ts)
 * - Planes: `/gui/battle_hud/markers/plane/...` art via `planeIcon()`.
 *
 * Variants follow the battle HUD: ally (green), enemy (red), white
 * (neutral), sunk (grey), plain (uncolored class icon).
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
          />
        );
      }
      return <span style={{ width: `${props.size}px`, height: `${props.size}px` }} />;
    };
  },
});
