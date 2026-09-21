import { defineComponent, ref } from "vue";
import { HButton, HSwitch, useToast } from "@celestia-island/hikari";
import { ImagePlus, RotateCcw } from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import RatingStamp from "@/components/base/RatingStamp";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { importStampImage, resetStampImage } from "@/stores/stampOverrides";
import type { StampKind } from "@/utils/winrate";
import "./SealCustomizer.scss";

/** The customizer's rows, in RatingStamp's canonical kind order; names are
 *  settings.json `sealCustomizer.*` keys. */
const SEALS: Array<{ kind: StampKind; nameKey: string }> = [
  { kind: "miracle", nameKey: "sealMiracle" },
  { kind: "ape", nameKey: "sealApe" },
  { kind: "maggot", nameKey: "sealMaggot" },
  { kind: "rat", nameKey: "sealRat" },
  { kind: "air", nameKey: "sealAir" },
  { kind: "sub", nameKey: "sealSub" },
];

/**
 * Per-seal customization rows for the settings modal's stats section: each
 * seal gets a live preview (default glyph, or the user's custom picture the
 * moment it lands), a show/hide switch (statsPrefs sealDisabled) and a
 * pick/reset pair for the custom image (commands::stamps — reset deletes
 * the file, which IS the fallback to the default glyph).
 *
 * The whole block renders only while seals can show at all — zh UI locale
 * AND the PR master AND the seals toggle on — mirroring RatingStamp's own
 * gates, so a dead customizer never takes the rows' space. Onboarding keeps
 * its simple control set; this is settings-only.
 */
export default defineComponent({
  name: "SealCustomizer",
  setup() {
    const prefs = useStatsPrefsStore();
    const { uiLocale } = useLanguage();
    const toast = useToast();
    const busy = ref<StampKind | null>(null);

    const visible = () =>
      uiLocale.value.startsWith("zh") && prefs.prefs.prEnabled && prefs.prefs.sealsEnabled;

    async function pick(kind: StampKind) {
      busy.value = kind;
      try {
        const imported = await importStampImage(kind);
        if (!imported) return; // dialog cancelled — nothing to report
      } catch (e) {
        toast.error(`${t("settings.sealCustomizer.pickFailed")}\n${(e as Error).message || e}`);
      } finally {
        busy.value = null;
      }
    }

    async function reset(kind: StampKind) {
      busy.value = kind;
      try {
        await resetStampImage(kind);
      } catch (e) {
        toast.error(`${t("settings.sealCustomizer.resetFailed")}\n${(e as Error).message || e}`);
      } finally {
        busy.value = null;
      }
    }

    return () => {
      if (!visible()) return null;
      return (
        <div class="seal-customizer">
          <p class="seal-customizer__hint">{t("settings.sealCustomizer.desc")}</p>
          {SEALS.map(({ kind, nameKey }) => {
            const disabled = prefs.prefs.sealDisabled[kind] === true;
            return (
              <div
                class={["seal-customizer__row", { "seal-customizer__row--off": disabled }]}
                key={kind}
              >
                <span class="seal-customizer__preview">
                  <RatingStamp kind={kind} size={34} />
                </span>
                <span class="seal-customizer__name">{t(`settings.sealCustomizer.${nameKey}`)}</span>
                <span class="seal-customizer__actions">
                  <HButton
                    variant="secondary"
                    size="sm"
                    loading={busy.value === kind}
                    disabled={disabled}
                    onClick={() => void pick(kind)}
                  >
                    <ImagePlus size={13} /> {t("settings.sealCustomizer.pickImage")}
                  </HButton>
                  <HButton
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void reset(kind)}
                  >
                    <RotateCcw size={13} /> {t("settings.sealCustomizer.resetDefault")}
                  </HButton>
                </span>
                <HSwitch
                  modelValue={!disabled}
                  onUpdate:modelValue={(v: boolean) => prefs.setSealDisabled(kind, !v)}
                />
              </div>
            );
          })}
        </div>
      );
    };
  },
});
