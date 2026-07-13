import { computed, defineComponent } from "vue";
import type { DogTag } from "@/api";

import "./PlayerBadge.scss";

/** Decode a WG ARGB-packed u32 color to a CSS rgba() string. */
function argbToCss(argb: number): string {
  const a = ((argb >> 24) & 0xff) / 255;
  const r = (argb >> 16) & 0xff;
  const g = (argb >> 8) & 0xff;
  const b = argb & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Player emblem badge. Renders the player's **dog tag** (personalized emblem)
 * from the WG Vortex API — using the actual border + background colors the
 * player chose in-game.
 *
 * The dog tag is a layered emblem: background color + texture pattern + center
 * symbol + border color. Since the texture/symbol image assets are on WG's CDN
 * behind signed URLs (not publicly accessible), we render the tag from the
 * **color values** only — producing a colored shield shape with the player's
 * actual color scheme. The center symbol is approximated with the player's
 * service record tier number.
 *
 * If no dog_tag data is available (Vortex fetch failed), falls back to a
 * tier-based badge (bronze→diamond).
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

    /** If we have dog_tag colors, compute CSS custom properties for the
     *  custom-colored rendering. */
    const dogTagStyle = computed(() => {
      if (!props.dogTag) return null;
      const bg = argbToCss(props.dogTag.backgroundColor);
      const border = argbToCss(props.dogTag.borderColor);
      return {
        "--dt-bg": bg,
        "--dt-border": border,
      } as Record<string, string>;
    });

    return () => (
      <div
        class={[
          "player-badge",
          props.dogTag ? "player-badge--dogtag" : tierClass.value,
        ]}
        style={[
          { width: `${props.size}px`, height: `${props.size}px` },
          dogTagStyle.value,
        ]}
        title={
          props.dogTag
            ? `Player emblem (Tier ${props.tier})`
            : `Service record tier ${props.tier}`
        }
      >
        {props.dogTag ? (
          [
            <img
              class="player-badge__dt-img"
              src="/dogtags/DT_Default.png"
              alt=""
            />,
            <span class="player-badge__tier">{props.tier || "?"}</span>,
          ]
        ) : (
          <span class="player-badge__tier">{props.tier || "?"}</span>
        )}
      </div>
    );
  },
});
