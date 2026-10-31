import { defineComponent, nextTick, ref, watch } from "vue";
import { HkSwitch, useToast } from "@celestia-island/hikari";
import { ImagePlus, RotateCcw } from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import RatingStamp from "@/components/base/RatingStamp";
import StampTag from "@/components/base/StampTag";
import ImageSquareCropModal, { type ImageCropResult } from "@/components/base/ImageSquareCropModal";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { importStampImage, resetStampImage, stampOverrideUrl } from "@/stores/stampOverrides";
import { stampTier, stampWording, type StampKind } from "@/utils/winrate";
import "./SealCustomizer.scss";

/** The customizer's rows in the seal-tier order (utils/winrate stampTier),
 *  grouped under the 一级章 / 二级章 headers: the primary tier — the
 *  single-character verdicts (神 / 猴 / 蛆) plus 过街老鼠, the square stamp
 *  faces — then the secondary tier — the four-character composition tags
 *  with their 奶龙 / 奶蛙 veteran tiers and the merged 空中神人 / 水下神人 /
 *  空中小猴 / 水下小猴 seals (the same order commands::stamps lists within
 *  each group); each row renders its award-criteria description
 *  (stats.json `stats.seal*Desc` keys) — the stamps carry no hover tooltip
 *  anywhere, so these rows ARE the only copy explaining a seal. */
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
 * grouped under the seal-tier headers (一级章 / 二级章). The two tiers
 * customize DIFFERENT things, because that is what the faces are:
 *
 *  - Tier 1 (the square stamp pictures): the preview IS the control — a
 *    seal on its default glyph opens the crop dialog on click, a
 *    customized seal deletes its picture and falls back to the default
 *    glyph on click (re-customizing is simply the next click). The hover
 *    veil (an image / restore glyph over the preview) carries the
 *    affordance; the stamps carry no hover tooltip.
 *  - Tier 2 (the horizontal StampTag faces): no icon capability at all —
 *    the tag's identity IS its wording, so the row renders the tag itself
 *    at the description's text size and clicking it opens the label
 *    editor bubble: an input plus 保存 / 重置, persisting through
 *    statsPrefs sealLabels (every face — rosters, overlay chips, aim
 *    card, share shots — reads the same map).
 *
 * Each row keeps its show/hide switch (statsPrefs sealDisabled). The whole
 * block renders only while seals can show at all — zh UI locale AND the PR
 * master AND the seals toggle on — mirroring RatingStamp's own gates, so a
 * dead customizer never takes the rows' space. Onboarding keeps its simple
 * control set; this is settings-only.
 */
export default defineComponent({
  name: "SealCustomizer",
  setup() {
    const prefs = useStatsPrefsStore();
    const { uiLocale } = useLanguage();
    const toast = useToast();
    const busy = ref<StampKind | null>(null);
    // The kind whose crop dialog is open — non-null opens the single shared
    // ImageSquareCropModal instance rendered below the rows (tier-1 only:
    // the secondary tier has no icon capability).
    const dialogKind = ref<StampKind | null>(null);
    // The tier-2 kind whose label editor bubble is open, and the draft the
    // input edits ("" = no custom label — the placeholder shows the default
    // wording that an empty value restores).
    const editingKind = ref<StampKind | null>(null);
    const draft = ref("");
    const editorWrap = ref<HTMLElement | null>(null);
    const editorInput = ref<HTMLInputElement | null>(null);

    const visible = () =>
      uiLocale.value.startsWith("zh") && prefs.prefs.prEnabled && prefs.prefs.sealsEnabled;

    /** The tier-1 preview click: still on the default glyph → the crop
     *  dialog (the seal face is a square shown at 34–64px, so the dialog
     *  enforces the square + min/max-side rules and previews the crop at
     *  real seal sizes, with the shared −9° press, before anything lands on
     *  disk); already customized → reset — deleting the file IS the
     *  fallback to the default glyph. */
    function onPreviewClick(kind: StampKind) {
      if (stampOverrideUrl(kind) != null) void reset(kind);
      else dialogKind.value = kind;
    }

    /** The tier-2 label click: open the editor bubble seeded with the
     *  kind's current custom label (empty while on the default wording). */
    function openLabelEditor(kind: StampKind) {
      editingKind.value = kind;
      draft.value = prefs.prefs.sealLabels[kind] ?? "";
    }

    function closeLabelEditor() {
      editingKind.value = null;
    }

    /** 保存: hand the draft to the store (it trims, caps and treats an
     *  empty value as "back to the default wording") and close. */
    function saveLabel() {
      const kind = editingKind.value;
      if (!kind) return;
      prefs.setSealLabel(kind, draft.value);
      closeLabelEditor();
    }

    /** 重置: drop the custom label outright — the default wording returns
     *  on every face at once (the store write is the whole operation). */
    function resetLabel() {
      const kind = editingKind.value;
      if (!kind) return;
      prefs.setSealLabel(kind, null);
      closeLabelEditor();
    }

    // One open editor at a time: a pointerdown outside the bubble (or
    // Escape) closes it without saving — the two buttons are the commit
    // paths. The listeners live exactly as long as the bubble does.
    watch(editingKind, (kind) => {
      if (kind == null) return;
      void nextTick(() => editorInput.value?.focus());
      const onPointerDown = (e: PointerEvent) => {
        if (editorWrap.value && !editorWrap.value.contains(e.target as Node)) {
          closeLabelEditor();
        }
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") closeLabelEditor();
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      watch(
        editingKind,
        () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        },
        { once: true },
      );
    });

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
                return (
                  <div
                    class={["seal-customizer__row", { "seal-customizer__row--off": disabled }]}
                    key={kind}
                  >
                    {stampTier(kind) === "primary" ? (
                      // ── Tier 1: the stamp picture IS the control ──
                      (() => {
                        const custom = stampOverrideUrl(kind) != null;
                        const hint = custom
                          ? t("settings.sealCustomizer.clickRemove")
                          : t("settings.sealCustomizer.clickEdit");
                        return (
                          <button
                            type="button"
                            class={[
                              "seal-customizer__preview",
                              { "seal-customizer__preview--custom": custom },
                            ]}
                            disabled={disabled || busy.value === kind}
                            aria-label={hint}
                            onClick={() => onPreviewClick(kind)}
                          >
                            <RatingStamp kind={kind} size={40} />
                            <span class="seal-customizer__afford" aria-hidden="true">
                              {custom ? <RotateCcw size={14} /> : <ImagePlus size={13} />}
                            </span>
                          </button>
                        );
                      })()
                    ) : (
                      // ── Tier 2: the tag face, clicked to edit its wording ──
                      <div
                        class="seal-customizer__label-wrap"
                        ref={(el) => {
                          if (editingKind.value === kind) {
                            editorWrap.value = el as unknown as HTMLElement | null;
                          }
                        }}
                      >
                        <button
                          type="button"
                          class="seal-customizer__label"
                          aria-label={t("settings.sealCustomizer.labelEdit")}
                          onClick={() => openLabelEditor(kind)}
                        >
                          <StampTag kind={kind} />
                        </button>
                        {editingKind.value === kind && (
                          <div class="seal-customizer__editor" role="group">
                            <input
                              ref={(el) => {
                                editorInput.value = el as unknown as HTMLInputElement | null;
                              }}
                              class="seal-customizer__editor-input"
                              type="text"
                              maxlength={8}
                              value={draft.value}
                              onInput={(e: Event) => {
                                draft.value = (e.target as HTMLInputElement).value;
                              }}
                              placeholder={stampWording(kind)}
                              aria-label={t("settings.sealCustomizer.labelInput")}
                              onKeydown={(e: KeyboardEvent) => {
                                if (e.key === "Enter") saveLabel();
                              }}
                            />
                            <div class="seal-customizer__editor-actions">
                              <button
                                type="button"
                                class="seal-customizer__editor-btn seal-customizer__editor-btn--primary"
                                onClick={saveLabel}
                              >
                                {t("settings.sealCustomizer.labelSave")}
                              </button>
                              <button
                                type="button"
                                class="seal-customizer__editor-btn"
                                onClick={resetLabel}
                              >
                                {t("settings.sealCustomizer.labelReset")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
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
