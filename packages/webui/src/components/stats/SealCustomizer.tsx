import { defineComponent, ref } from "vue";
import { HkButton, HkSwitch, useToast } from "@celestia-island/hikari";
import { ImagePlus, RotateCcw } from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import RatingStamp from "@/components/base/RatingStamp";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { importStampImage, resetStampImage } from "@/stores/stampOverrides";
import type { StampKind } from "@/utils/winrate";
import "./SealCustomizer.scss";

/** The customizer's rows, in RatingStamp's canonical kind order; each row
 *  renders its award-criteria description (stats.json `stats.seal*Desc`
 *  keys) — the stamps already carry their own name glyph, and the same copy
 *  serves as RatingStamp's hover tooltip. */
const SEALS: Array<{ kind: StampKind; descKey: string }> = [
  { kind: "miracle", descKey: "sealMiracleDesc" },
  { kind: "ape", descKey: "sealApeDesc" },
  { kind: "maggot", descKey: "sealMaggotDesc" },
  { kind: "rat", descKey: "sealRatDesc" },
  { kind: "air", descKey: "sealAirDesc" },
  { kind: "sub", descKey: "sealSubDesc" },
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
          {SEALS.map(({ kind, descKey }) => {
            const disabled = prefs.prefs.sealDisabled[kind] === true;
            return (
              <div
                class={["seal-customizer__row", { "seal-customizer__row--off": disabled }]}
                key={kind}
              >
                <span class="seal-customizer__preview">
                  <RatingStamp kind={kind} size={34} />
                </span>
                <span class="seal-customizer__desc">{t(`stats.${descKey}`)}</span>
                <span class="seal-customizer__actions">
                  <HkButton
                    variant="secondary"
                    size="sm"
                    loading={busy.value === kind}
                    disabled={disabled}
                    onClick={() => void pick(kind)}
                  >
                    <ImagePlus size={13} /> {t("settings.sealCustomizer.pickImage")}
                  </HkButton>
                  <HkButton
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void reset(kind)}
                  >
                    <RotateCcw size={13} /> {t("settings.sealCustomizer.resetDefault")}
                  </HkButton>
                </span>
                <HkSwitch
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
