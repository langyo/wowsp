import { defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";
import { stampOverrideUrl } from "@/stores/stampOverrides";
import type { StampKind } from "@/utils/winrate";
import "./StampTag.scss";

/** The four-character composition tags' and the merged seals' wording —
 *  the same strings RatingStamp's faces carry (the seal vocabulary is
 *  locale-free CJK). */
const TAG_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "猴",
  maggot: "蛆",
  rat: "过街老鼠",
  air: "空中小人",
  sub: "水下小人",
  airVeteran: "空中奶龙",
  subVeteran: "水下奶蛙",
  airMiracle: "空中神人",
  subMiracle: "水下神人",
  airApe: "空中小猴",
  subApe: "水下小猴",
};

/** Award-criteria tooltip keys (stats.json) — the same copy RatingStamp's
 *  hover tooltips and the seal customizer rows use. */
const TAG_DESC_KEYS: Record<StampKind, string> = {
  miracle: "stats.sealMiracleDesc",
  ape: "stats.sealApeDesc",
  maggot: "stats.sealMaggotDesc",
  rat: "stats.sealRatDesc",
  air: "stats.sealAirDesc",
  sub: "stats.sealSubDesc",
  airVeteran: "stats.sealAirVeteranDesc",
  subVeteran: "stats.sealSubVeteranDesc",
  airMiracle: "stats.sealAirMiracleDesc",
  subMiracle: "stats.sealSubMiracleDesc",
  airApe: "stats.sealAirApeDesc",
  subApe: "stats.sealSubApeDesc",
};

/**
 * The SECONDARY seal face (二级章, 印章样式的小标签): a horizontal
 * transparent tag with cinnabar ink and a rounded cinnabar border — like a
 * rubber-stamp impression, but in the small tag mode. The four-character
 * composition tags (空中小人 / 水下小人 / 空中奶龙 / 水下奶蛙) and the merged
 * 空中神人-family seals render through this face beside the roster
 * nicknames on the live and post-battle rosters (their rows are far too
 * short for a square 2x2 face, and the four-char wording reads as part of
 * the identity line); the single-character verdicts keep the square
 * RatingStamp picture (一级章). The wording/desc maps stay total over
 * StampKind so any kind passed by a future caller renders labelled —
 * callers route primary kinds to RatingStamp (utils/winrate stampTier).
 *
 * A user-imported custom picture (settings' seal customizer →
 * commands::stamps) replaces the text with the picture, pressed at the
 * tag's line-box height. Deliberately NOT tilted: a horizontal row of
 * stamps with mixed tilts reads as sloppiness, and the tag's rubber-stamp
 * voice comes from the ink + border alone.
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
      const text = TAG_TEXT[props.kind];
      const desc = t(TAG_DESC_KEYS[props.kind]);
      const custom = stampOverrideUrl(props.kind);
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
            title={desc}
          />
        );
      }
      return (
        <span class="stamp-tag" role="img" aria-label={text} title={desc}>
          {text}
        </span>
      );
    };
  },
});
