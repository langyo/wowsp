/**
 * A ship-class glyph for chips and pills — the water-meter's type-facet
 * icon (also used by the ship picker and the PR trend popup).
 *
 * The art is the game's battle-HUD class silhouette, served as SVG
 * (`features/holographic/shipIcons.ts`). The HUD set is WHITE plate art
 * built for the dark battle map: as an <img> at chip size it vanished on
 * light surfaces, kept its black plate outline (the "white" variant is
 * two-tone) and, because the 27 px HUD canvas kept ~40% padding, shrank into
 * a squiggle. The "plain" variant is the bare silhouette — with the class
 * engraving punched through as transparent slits — so
 * the glyph is drawn as a CSS MASK over the surrounding text ink instead
 * (`background-color: currentColor`): it follows the scheme, the pill's
 * active tint and the DPR. The mask box insets the tight art to 80% so the
 * silhouette keeps the bitmap-era visual weight in the chip row.
 */
import { defineComponent } from "vue";

import { shipIconUrl } from "@/features/holographic/shipIcons";
import "./ShipTypeGlyph.scss";

export default defineComponent({
  name: "ShipTypeGlyph",
  props: {
    /** WG ShipInfo.type (or the facet's type key); unknown types render
     *  an empty box so label alignment never shifts. */
    type: { type: String, required: true },
    /** Box width (px) — the chip row uses the default 22, the table/row
     *  glyphs pass their icon size. */
    width: { type: Number, default: 22 },
    /** Box height (px). */
    height: { type: Number, default: 12 },
  },
  setup(props) {
    return () => {
      const url = shipIconUrl(props.type, "plain");
      const box = { width: `${props.width}px`, height: `${props.height}px` };
      return (
        <span
          class="ship-type-glyph"
          aria-hidden="true"
          style={url ? { ...box, "--ship-type-glyph": `url(${url})` } : box}
        />
      );
    };
  },
});
