import { defineComponent } from "vue";
import { User } from "@lucide/vue";

import "./AccountAvatar.scss";

/**
 * Neutral account avatar — the placeholder disc for account rows whose
 * player has no dog-tag emblem to show (sidebar footer, tray panel).
 * Chrome mirrors PlatformIcon's badge (same translucent border, radius and
 * muted fill; glyph at the same 48% ratio) so it sits beside a platform
 * badge as an equal, and it deliberately carries NO service-record tier
 * number: at 22px the number read like a permission rank, and the tier
 * badge's 3px metallic ring shrank the visible disc below the platform
 * badge beside it.
 */
export default defineComponent({
  name: "AccountAvatar",
  props: {
    size: { type: Number, default: 22 },
  },
  setup(props) {
    return () => (
      <span
        class="account-avatar"
        style={{ width: `${props.size}px`, height: `${props.size}px` }}
        aria-hidden="true"
      >
        <User
          size={Math.max(10, Math.round(props.size * 0.48))}
          class="account-avatar__glyph"
        />
      </span>
    );
  },
});
