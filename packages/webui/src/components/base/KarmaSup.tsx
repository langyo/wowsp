import { defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import "./KarmaSup.scss";

/**
 * The player karma superscript — the WG account-info net like/report count
 * (点赞 − 举报), pressed to the TOP-RIGHT of a player nickname: the
 * live-roster rows, the post-battle rows and the stats cards' identity head
 * all mount this one face, so the figure reads as part of the identity line
 * on every surface (the user's requested placement — a raised index figure,
 * not a stat column). The zh-CN copy says 声望 — the simplified-Chinese
 * client's own official label (IDS_YOUR_KARMA: 亚服简体 声望, 国服 战场表现,
 * 亚服繁體 業力); 业力 stays the community shorthand in dev comments.
 *
 * The figure renders PLAIN — the number exactly as the API answers it, no
 * sign and no value-based color: karma only ever carries positive counts
 * and 0, so a "+" prefix or a green/red banding would be invented
 * emphasis (user feedback). Renders NOTHING while the value is
 * null/undefined: karma is absent on hidden profiles, on answers older
 * than the field (session caches, replay snapshots), and for bots — a
 * missing figure must not paint a misleading "0".
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
      return (
        <sup class="karma-sup" data-hint={`${t("common.karma")}: ${v}`}>
          {v}
        </sup>
      );
    };
  },
});
