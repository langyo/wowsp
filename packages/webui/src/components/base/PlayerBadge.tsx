import { computed, defineComponent } from "vue";

import "./PlayerBadge.scss";

/**
 * Player service-record badge. Renders a rank-style circular badge based on
 * the WG `leveling_tier` value (1–100+). Higher tiers get richer colors and
 * a tier-based ring style — mirroring how WoWS shows player level badges in
 * the game client.
 *
 * The badge is pure CSS (no external images — WG doesn't expose player
 * avatar URLs via the API). The color tier matches community conventions:
 *   1–10:   bronze
 *   11–25:  silver
 *   26–50:  gold
 *   51–75:  platinum
 *   76+:    diamond
 */
export default defineComponent({
  name: "PlayerBadge",
  props: {
    tier: { type: Number, default: 0 },
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
    return () => (
      <div
        class={["player-badge", tierClass.value]}
        style={{ width: `${props.size}px`, height: `${props.size}px` }}
        title={`Service record tier ${props.tier}`}
      >
        <span class="player-badge__tier">{props.tier || "?"}</span>
      </div>
    );
  },
});
