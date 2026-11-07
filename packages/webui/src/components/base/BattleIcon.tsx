/**
 * Battle-icon component — the DOM face of the project's ONE ship/aircraft
 * class-glyph provider (the canvas faces preload and draw the same art
 * through `shipIcons.ts`'s `shipIconUrl()`, so every surface shows
 * identical art at every size).
 *
 * - Ships: the game's OWN HUD markers
 *   (`/gui/battle_hud/markers/ship/icon_{variant}_{class}.png`), authored as
 *   GEOMETRY by `scripts/model_convert/ship_class_glyphs.py` (a flat hull,
 *   a bow wedge, the speed slashes) so it renders crisp at every size and
 *   DPR — no bitmap tracing.
 * - Planes: `/gui/battle_hud/markers/plane/...` art via `planeIcon()`.
 *
 * Variants follow the battle HUD: ally / enemy (team plate, BLACK ink),
 * white (light plate, black ink; also the tooltip/hint face), sunk (the
 * inverted state marker: black plate, white ink — see the generator's INK
 * RULE), plain (the one-colour silhouette drawn as a CSS mask by
 * ShipTypeGlyph so it follows the surrounding text ink).
 */
import { defineComponent, computed } from "vue";

import { shipIconUrl } from "@/features/holographic/shipIcons";
import type { ShipIconVariant } from "@/features/holographic/shipIcons";
import planeIcon from "@/features/holographic/planeIcons";
import ShipTypeGlyph from "@/components/base/ShipTypeGlyph";

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
      // The "plain" glyph is the UNCOLORED class silhouette, so it must ink
      // like the surrounding text. As an <img> it was white plate art and
      // vanished on light surfaces (user report: "the outlines are almost
      // gone" in the replay list), and at row size the art's canvas padding
      // shrank it to a squiggle. ShipTypeGlyph draws the same SVG as a
      // mask over currentColor — crisp, scheme-aware, and it fills the box.
      // The colored HUD variants (ally/enemy/sunk/white) keep their <img>
      // because their paint IS the information.
      if (props.variant === "plain") {
        return <ShipTypeGlyph type={props.type} width={props.size} height={props.size} />;
      }
      if (url.value) {
        // Every face draws the SAME art and must weigh the same at one
        // `size`. The shipped SVGs' viewBox is the marker itself (a 0.5
        // art-unit margin), while the mask face insets the art to 80% of
        // its box (ShipTypeGlyph.scss), so an image face at the raw box size
        // reads ~25% heavier — the
        // post-battle roster's size-20 rows were the surface that exposed it
        // (2026-11-07 review: "战后统计界面等的图标也是过大了"). Inset the
        // image by the same 10% per side so the two face kinds agree.
        return (
          <img
            src={url.value}
            width={props.size}
            height={props.size}
            alt=""
            draggable={false}
            decoding="sync"
            style={{ padding: `${props.size * 0.1}px`, boxSizing: "border-box" }}
          />
        );
      }
      return <span style={{ width: `${props.size}px`, height: `${props.size}px` }} />;
    };
  },
});
