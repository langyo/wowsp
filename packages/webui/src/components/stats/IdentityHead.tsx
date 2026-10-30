import { defineComponent, type PropType } from "vue";

import KarmaSup from "@/components/base/KarmaSup";
import { t } from "@/i18n";
import "./IdentityHead.scss";

/**
 * Shared identity head for the stats cards: `[TAG] name` on the left,
 * trailing badges (realm, hidden, …) on the right. StatsCard (player) and
 * ClanCard (clan) render the same strip so both pages read identically;
 * the clan tag becomes a jump button whenever a click handler is given.
 *
 * The optional `karma` prop is the player karma (the WG account net
 * like/report count) rendered as a RAISED SUPERSCRIPT at the nickname's
 * top-right — the badge is a separate flex item after the <h3>, so a long
 * nickname still ellipsizes instead of being pushed out of the row. Clan
 * cards pass nothing (karma is a player-only figure) and hidden profiles /
 * old cache blobs carry null/undefined → nothing renders.
 *
 * Slots:
 *   avatar — leading visual (PlayerBadge on the player card).
 *   badges — trailing HkTag row.
 *   actions — rightmost pill buttons after the badges (the share-shot
 *     button mounts here, keeping the action in the card's top-right
 *     corner on every water-table surface).
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
    /** Extra class on the name heading (the marked-name tint rides
     *  here; clan cards omit it). */
    nameClass: { type: String, default: "" },
    /** Player karma (业力) for the top-right-of-nickname superscript;
     *  null/undefined (clan cards, hidden profiles, older caches)
     *  renders nothing. Gated by the `cardKarmaEnabled` pref at the
     *  caller, so this stays a dumb display prop. */
    karma: { type: Number as PropType<number | null>, default: null },
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
                data-hint={t("lookup.jumpClan")}
              >
                [{props.tag}]
              </button>
            ) : (
              <span class="id-head__tag">[{props.tag}]</span>
            )
          ) : null}
          <h3 class={["id-head__name", props.nameClass]}>{props.name}</h3>
          {props.karma != null ? (
            <KarmaSup value={props.karma} class="id-head__karma" />
          ) : null}
        </div>
        <div class="id-head__badges">
          {slots.badges?.()}
          {slots.actions?.()}
        </div>
      </header>
    );
  },
});
