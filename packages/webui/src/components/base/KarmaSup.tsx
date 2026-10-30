import { defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import "./KarmaSup.scss";

/**
 * The player karma (业力) superscript — the WG account-info net like/report
 * count (点赞 − 举报), pressed to the TOP-RIGHT of a player nickname: the
 * live-roster rows, the post-battle rows and the stats cards' identity head
 * all mount this one face, so the figure reads as part of the identity line
 * on every surface (the user's requested placement — a raised index figure,
 * not a stat column).
 *
 * Renders NOTHING while the value is null/undefined: karma is absent on
 * hidden profiles, on answers older than the field (session caches, replay
 * snapshots), and for bots — a missing figure must not paint a misleading
 * "0". Positive counts tint green and carry an explicit "+", negative ones
 * red, zero stays muted (zero is a real verdict and keeps rendering).
 */
export default defineComponent({
  name: "KarmaSup",
  props: {
    /** The karma figure straight off the WG answer (null = not carried). */
    value: { type: Number as PropType<number | null | undefined>, default: null },
  },
  setup(props) {
    return () => {
      const v = props.value;
      if (v == null) return null;
      const sign = v > 0 ? "--pos" : v < 0 ? "--neg" : "--zero";
      return (
        <sup
          class={["karma-sup", `karma-sup${sign}`]}
          data-hint={`${t("common.karma")}: ${v.toLocaleString()}`}
        >
          {v > 0 ? `+${v}` : `${v}`}
        </sup>
      );
    };
  },
});
