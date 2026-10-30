import { defineComponent, ref } from "vue";
import { HkSwitch, useToast } from "@celestia-island/hikari";
import { ImagePlus, RotateCcw } from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import RatingStamp from "@/components/base/RatingStamp";
import StampTag from "@/components/base/StampTag";
import ImageSquareCropModal, { type ImageCropResult } from "@/components/base/ImageSquareCropModal";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { importStampImage, resetStampImage, stampOverrideUrl } from "@/stores/stampOverrides";
import { stampTier, type StampKind } from "@/utils/winrate";
import "./SealCustomizer.scss";

/** The customizer's rows in the seal-tier order (utils/winrate stampTier),
 *  grouped under the 一级章 / 二级章 headers: the primary tier — the
 *  single-character verdicts (神 / 猴 / 蛆) plus 过街老鼠, the square stamp
 *  faces — then the secondary tier — the four-character composition tags
 *  with their 奶龙 / 奶蛙 veteran tiers and the merged 空中神人 / 水下神人 /
 *  空中小猴 / 水下小猴 seals (the same order commands::stamps lists within
 *  each group); each row renders its award-criteria description
 *  (stats.json `stats.seal*Desc` keys) — the stamps already carry their own
 *  name glyph, and the same copy serves as the hover tooltip. */
const SEAL_TIERS: Array<{ tier: 1 | 2; kinds: Array<{ kind: StampKind; descKey: string }> }> = [
  {
    tier: 1,
    kinds: [
      { kind: "miracle", descKey: "sealMiracleDesc" },
      { kind: "ape", descKey: "sealApeDesc" },
      { kind: "maggot", descKey: "sealMaggotDesc" },
      { kind: "rat", descKey: "sealRatDesc" },
    ],
  },
  {
    tier: 2,
    kinds: [
      { kind: "air", descKey: "sealAirDesc" },
      { kind: "sub", descKey: "sealSubDesc" },
      { kind: "airVeteran", descKey: "sealAirVeteranDesc" },
      { kind: "subVeteran", descKey: "sealSubVeteranDesc" },
      { kind: "airMiracle", descKey: "sealAirMiracleDesc" },
      { kind: "subMiracle", descKey: "sealSubMiracleDesc" },
      { kind: "airApe", descKey: "sealAirApeDesc" },
      { kind: "subApe", descKey: "sealSubApeDesc" },
    ],
  },
];

/**
 * Per-seal customization rows for the settings modal's stats section,
 * grouped under the seal-tier headers (一级章 / 二级章). The preview IS the
 * control — no pick/reset button pair beside it: a seal on
 * its default glyph opens the crop dialog on click, and a customized seal
 * deletes its picture and falls back to the default glyph on click
 * (re-customizing is simply the next click). The hover veil (an image /
 * restore glyph over the preview) carries the affordance; each row keeps
 * its show/hide switch (statsPrefs sealDisabled).
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

    /** The preview click: still on the default glyph → the crop dialog (the
     *  seal face is a square shown at 34–64px, so the dialog enforces the
     *  square + min/max-side rules and previews the crop at real seal sizes,
     *  with the shared −9° press, before anything lands on disk); already
     *  customized → reset — deleting the file IS the fallback to the default
     *  glyph. */
    function onPreviewClick(kind: StampKind) {
      if (stampOverrideUrl(kind) != null) void reset(kind);
      else dialogKind.value = kind;
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
          {SEAL_TIERS.map(({ tier, kinds }) => (
            <div class="seal-customizer__tier" key={tier}>
              <p class="seal-customizer__tier-title">
                {t(tier === 1 ? "settings.sealCustomizer.tier1" : "settings.sealCustomizer.tier2")}
              </p>
              {kinds.map(({ kind, descKey }) => {
                const disabled = prefs.prefs.sealDisabled[kind] === true;
                const custom = stampOverrideUrl(kind) != null;
                const hint = custom
                  ? t("settings.sealCustomizer.clickRemove")
                  : t("settings.sealCustomizer.clickEdit");
                return (
                  <div
                    class={["seal-customizer__row", { "seal-customizer__row--off": disabled }]}
                    key={kind}
                  >
                    <button
                      type="button"
                      class={[
                        "seal-customizer__preview",
                        { "seal-customizer__preview--custom": custom },
                      ]}
                      disabled={disabled || busy.value === kind}
                      data-hint={hint}
                      aria-label={hint}
                      onClick={() => onPreviewClick(kind)}
                    >
                      {/* Each tier previews its own face: the primary tier
                          the square stamp picture, the secondary tier the
                          horizontal StampTag (the face the rosters show). */}
                      {stampTier(kind) === "primary" ? (
                        <RatingStamp kind={kind} size={40} />
                      ) : (
                        <StampTag kind={kind} />
                      )}
                      <span class="seal-customizer__afford" aria-hidden="true">
                        {custom ? <RotateCcw size={14} /> : <ImagePlus size={13} />}
                      </span>
                    </button>
                    <span class="seal-customizer__desc">{t(`stats.${descKey}`)}</span>
                    <HkSwitch
                      modelValue={!disabled}
                      onUpdate:modelValue={(v: boolean) => prefs.setSealDisabled(kind, !v)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
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
