import { defineComponent, type PropType } from "vue";

import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";
import { stampOverrideUrl } from "@/stores/stampOverrides";
import { stampTier, stampWording, type StampKind } from "@/utils/winrate";
import "./StampTag.scss";

/**
 * The SMALL-TAG seal face (印章样式的小标签): a horizontal transparent tag
 * with cinnabar ink and a rounded cinnabar border — like a rubber-stamp
 * impression, but in the small tag mode. The four-character composition
 * tags (空中小人 / 水下小人 / 空中奶龙 / 水下奶蛙) and the merged
 * 空中神人-family seals render through this face beside the roster
 * nicknames on the live roster (its rows are far too short for a square 2x2
 * face, and the four-char wording reads as part of the identity line). On
 * the post-battle results matrix the same tag face also carries the career
 * VERDICTS (神了 / 猴 / 蛆 / 过街老鼠): its right-hand stamp column was retired
 * and every seal now leads the nickname line as a small tag (user feedback).
 * The water meter and the remaining square surfaces still press the
 * primary tier through RatingStamp (一级章, utils/winrate stampTier).
 *
 * The wording is the shared STAMP_WORDING (utils/winrate — the one map the
 * overlay chips, the aim card and the share renderer read too); a label the
 * user edited in the seal customizer (statsPrefs sealLabels) replaces it on
 * every face. The seals' hover tooltips are retired (user feedback) — the
 * award criteria live in the customizer rows alone.
 *
 * A user-imported custom picture (settings' seal customizer →
 * commands::stamps) replaces the TEXT with the picture, pressed at the
 * tag's line-box height — but only for the PRIMARY tier: the secondary
 * tier has no icon capability at all (its identity IS the wording, editable
 * through the customizer's label editor), so a tier-2 picture file left on
 * disk by an older build is ignored. Deliberately NOT tilted: a horizontal
 * row of stamps with mixed tilts reads as sloppiness, and the tag's
 * rubber-stamp voice comes from the ink + border alone.
 *
 * The seals are a Chinese-community artifact — this renders nothing under
 * any other UI language, and a seal switched off individually (statsPrefs
 * sealDisabled) never renders either. The PR/seals master gates are the
 * hosts' (as with RatingStamp).
 */
export default defineComponent({
  name: "StampTag",
  props: {
    kind: { type: String as PropType<StampKind>, required: true },
  },
  setup(props) {
    const { uiLocale } = useLanguage();

    return () => {
      if (!uiLocale.value.startsWith("zh")) return null;
      if (statsPrefsState.value.sealDisabled[props.kind]) return null;
      const text = stampWording(props.kind, statsPrefsState.value.sealLabels);
      const custom =
        stampTier(props.kind) === "primary" ? stampOverrideUrl(props.kind) : null;
      if (custom != null) {
        // The user's own picture replaces the text, pressed at the text
        // seal's line-box height (the same calibration the overlay chips
        // apply to their custom pictures).
        return (
          <img
            class="stamp-tag"
            src={custom}
            alt={text}
            role="img"
            aria-label={text}
          />
        );
      }
      return (
        <span class="stamp-tag" role="img" aria-label={text}>
          {text}
        </span>
      );
    };
  },
});
