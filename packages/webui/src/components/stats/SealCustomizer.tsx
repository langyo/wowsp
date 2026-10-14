import { defineComponent, ref } from "vue";
import { HkButton, HkSwitch, useToast } from "@celestia-island/hikari";
import { ImagePlus, RotateCcw } from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import RatingStamp from "@/components/base/RatingStamp";
import ImageSquareCropModal, { type ImageCropResult } from "@/components/base/ImageSquareCropModal";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { importStampImage, resetStampImage } from "@/stores/stampOverrides";
import type { StampKind } from "@/utils/winrate";
import "./SealCustomizer.scss";

/** The customizer's rows, in RatingStamp's canonical kind order (career
 *  verdicts, then the composition tags with their 奶龙 / 奶蛙 veteran tiers, then
 *  the merged 空中神人 / 水下神人 / 空中小猴 / 水下小猴 seals — the same
 *  order commands::stamps lists); each row renders its award-criteria
 *  description (stats.json `stats.seal*Desc` keys) — the stamps already
 *  carry their own name glyph, and the same copy serves as RatingStamp's
 *  hover tooltip. */
const SEALS: Array<{ kind: StampKind; descKey: string }> = [
  { kind: "miracle", descKey: "sealMiracleDesc" },
  { kind: "ape", descKey: "sealApeDesc" },
  { kind: "maggot", descKey: "sealMaggotDesc" },
  { kind: "rat", descKey: "sealRatDesc" },
  { kind: "air", descKey: "sealAirDesc" },
  { kind: "sub", descKey: "sealSubDesc" },
  { kind: "airVeteran", descKey: "sealAirVeteranDesc" },
  { kind: "subVeteran", descKey: "sealSubVeteranDesc" },
  { kind: "airMiracle", descKey: "sealAirMiracleDesc" },
  { kind: "subMiracle", descKey: "sealSubMiracleDesc" },
  { kind: "airApe", descKey: "sealAirApeDesc" },
  { kind: "subApe", descKey: "sealSubApeDesc" },
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
    // The kind whose crop dialog is open — non-null opens the single shared
    // ImageSquareCropModal instance rendered below the rows.
    const dialogKind = ref<StampKind | null>(null);

    const visible = () =>
      uiLocale.value.startsWith("zh") && prefs.prefs.prEnabled && prefs.prefs.sealsEnabled;

    /** "自定义图片" opens the crop dialog instead of a bare file picker: the
     *  seal face is a square shown at 34–64px, so the dialog enforces the
     *  square + min/max-side rules and previews the crop at real seal sizes
     *  (with the shared −9° press) before anything lands on disk. */
    function pick(kind: StampKind) {
      dialogKind.value = kind;
    }

    async function onCropConfirm({ bytes, ext }: ImageCropResult) {
      const kind = dialogKind.value;
      if (!kind) return;
      busy.value = kind;
      try {
        await importStampImage(kind, bytes, ext);
      } catch (e) {
        toast.error(`${t("settings.sealCustomizer.pickFailed")}\n${(e as Error).message || e}`);
      } finally {
        busy.value = null;
        dialogKind.value = null;
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
                  <RatingStamp kind={kind} size={40} />
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
          <ImageSquareCropModal
            modelValue={dialogKind.value != null}
            title={t("settings.sealCustomizer.dialogTitle")}
            previewSizes={[64, 40]}
            previewTransform="rotate(-9deg)"
            onUpdate:modelValue={(v: boolean) => {
              if (!v) dialogKind.value = null;
            }}
            onConfirm={(result: ImageCropResult) => void onCropConfirm(result)}
          />
        </div>
      );
    };
  },
});
