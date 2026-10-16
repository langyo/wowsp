import { defineComponent, type PropType } from "vue";

import { HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  FONT_SCALE_LEVELS,
  fontScaleLevel,
  setFontScaleLevel,
  type FontScaleLevel,
} from "@/theme/fontScalePreference";

/** Level → label key suffix (fontSizeXS … fontSizeXL), resolved under the
 *  host surface's namespace by `tr` below. */
const LEVEL_LABEL_KEYS: Record<FontScaleLevel, string> = {
  [-2]: "fontSizeXS",
  [-1]: "fontSizeS",
  0: "fontSizeM",
  1: "fontSizeL",
  2: "fontSizeXL",
};

/**
 * The five-way font-size segmented control (smallest … default … largest),
 * reading and writing the shared fontScalePreference module. One component,
 * two hosts: the onboarding wizard's appearance step and the settings
 * modal's appearance section render the identical control through the `ns`
 * prop — the two surfaces carry their own i18n copies whose keys are kept
 * in sync (onboarding.json top level ↔ settings.json top level, both
 * `fontSize*`). Selection applies immediately (live preview).
 */
export default defineComponent({
  name: "FontSizeControl",
  props: {
    ns: {
      type: String as PropType<"onboarding" | "settings">,
      default: "settings",
    },
  },
  setup(props) {
    const tr = (key: string) => t(`${props.ns}.${key}`);

    return () => (
      <HkTabs
        block
        variant="segmented"
        // HkTabs keys are strings — bind the level through its stringified
        // form and convert back on update.
        modelValue={String(fontScaleLevel.value)}
        onUpdate:modelValue={(v: string) => setFontScaleLevel(Number(v) as FontScaleLevel)}
        tabs={FONT_SCALE_LEVELS.map((level) => ({
          key: String(level),
          label: tr(LEVEL_LABEL_KEYS[level]),
        }))}
      />
    );
  },
});
