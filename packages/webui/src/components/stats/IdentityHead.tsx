import { defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import "./IdentityHead.scss";

/**
 * Shared identity head for the stats cards: `[TAG] name` on the left,
 * trailing badges (realm, hidden, …) on the right. StatsCard (player) and
 * ClanCard (clan) render the same strip so both pages read identically;
 * the clan tag becomes a jump button whenever a click handler is given.
 *
 * Slots:
 *   avatar — leading visual (PlayerBadge on the player card).
 *   badges — trailing HTag row.
 */
export default defineComponent({
  name: "IdentityHead",
  props: {
    /** Display name — player nickname or clan name. */
    name: { type: String, required: true },
    /** Clan tag rendered as `[TAG]` left of the name; null hides it. */
    tag: { type: String as PropType<string | null>, default: null },
    /** Tag click → jump to the clan view; absent renders a plain span. */
    onTagClick: Function as PropType<() => void>,
  },
  setup(props, { slots }) {
    return () => (
      <header class="id-head">
        <div class="id-head__name-line">
          {slots.avatar?.()}
          {props.tag ? (
            props.onTagClick ? (
              <button
                type="button"
                class="id-head__tag id-head__tag--link"
                onClick={() => props.onTagClick?.()}
                title={t("lookup.jumpClan")}
              >
                [{props.tag}]
              </button>
            ) : (
              <span class="id-head__tag">[{props.tag}]</span>
            )
          ) : null}
          <h3 class="id-head__name">{props.name}</h3>
        </div>
        <div class="id-head__badges">{slots.badges?.()}</div>
      </header>
    );
  },
});
