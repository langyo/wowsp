import { defineComponent } from "vue";

import { t } from "@/i18n";
import "./DivisionTag.scss";

/**
 * The division tag (组队标签) — StampTag's small-tag face pressed in
 * YELLOW ink: a horizontal transparent tag with a rounded yellow border,
 * the seals' rubber-stamp voice carrying a battle FACT instead of a
 * community verdict. Players who queued as a division (组队) wear the
 * same letter in front of the nickname (组队A / 组队B / …) on the live
 * roster and the post-battle matrix alike; the share shot redraws the
 * same face in canvas (shotKit's drawDivisionTag).
 *
 * Because a division membership is battle data rather than seal art,
 * this face renders under EVERY UI locale and carries NO stats-prefs
 * gate — the two gates the seals ride (zh-locale, seals master)
 * deliberately do not exist here. The wording localizes through
 * replay.postbattle.divisionTag ({letter}).
 */
export default defineComponent({
  name: "DivisionTag",
  props: {
    letter: { type: String, required: true },
  },
  setup(props) {
    return () => {
      const text = t("replay.postbattle.divisionTag", { letter: props.letter });
      return (
        <span class="division-tag" role="img" aria-label={text}>
          {text}
        </span>
      );
    };
  },
});
