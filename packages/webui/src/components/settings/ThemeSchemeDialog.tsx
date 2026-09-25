import { computed, defineComponent, nextTick, ref, watch, type PropType } from "vue";
import {
  HkColorSchemeEditor,
  HkModal,
  themePresets,
  useTheme,
  type HkCustomTheme,
  type ModalAction,
  type ThemePreset,
} from "@celestia-island/hikari";

import { t } from "@/i18n";

/** The editor's imperative surface (defineExpose members are runtime-only
 *  and outside InstanceType — type the ref structurally, hikari's own
 *  HColorSchemeDialog does the same). */
interface SchemeEditorExpose {
  reset: () => void;
  getDraft: () => HkCustomTheme;
}

/**
 * ThemeSchemeDialog — wowsp's full color-scheme editor window, the same
 * surface shittim-chest hosts: hikari's HkColorSchemeEditor (the seven
 * accent tokens per dark/light mode plus the on-solid content colors, the
 * remaining surface tokens derived, extension token groups when registered)
 * inside an HkModal.
 *
 * The edit target resolves through props.schemeId, chest grammar:
 *  · a CUSTOM id edits in place — hikari's addCustomTheme upserts by id,
 *    so saving keeps the identity and an active selection re-applies via
 *    setTheme;
 *  · a BUILTIN preset id ALSO edits in place — the save is a custom whose
 *    id SHADOWS the preset (hikari resolves custom-over-preset and the
 *    settings list dedupes to one row, so the row's delete affordance
 *    restores the factory preset);
 *  · null is a blank canvas — the editor seeds itself from the stock
 *    default preset and mints a fresh custom-theme id on save.
 *
 * chest's name/icon/CSS-mount identity tab has no wowsp counterpart (no
 * server theme registry here); the editor's built-in name field covers
 * naming.
 */
export default defineComponent({
  name: "ThemeSchemeDialog",
  props: {
    modelValue: { type: Boolean, required: true },
    /** Theme id to prefill the editor with; null = blank canvas. */
    schemeId: { type: String as PropType<string | null>, default: null },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    const theme = useTheme();
    const editorRef = ref<SchemeEditorExpose | null>(null);

    /** The edit target: the user's stored custom first (an override of a
     *  builtin id edits THE OVERRIDE, never the shadowed factory), then
     *  the live preset table. */
    const target = computed(() => {
      const id = props.schemeId;
      if (!id) return null;
      const custom = theme.customThemes.value.find((c) => c.id === id);
      if (custom) {
        return { id, name: custom.name, dark: custom.dark, light: custom.light, groups: custom.groups };
      }
      const preset = (themePresets as Record<string, ThemePreset>)[id];
      if (preset) {
        return { id, name: preset.name, dark: preset.dark, light: preset.light, groups: preset.groups };
      }
      return null;
    });

    // Re-seed on every open so the editor replays the (possibly changed)
    // prefills and follows the current effective mode — reset() is the
    // editor's documented open-time entry point.
    watch(
      () => props.modelValue,
      (open) => {
        if (open) void nextTick(() => editorRef.value?.reset());
      },
    );

    function close() {
      emit("update:modelValue", false);
    }

    function onSave() {
      const draft = editorRef.value?.getDraft();
      if (!draft) return;
      // In-place edit keeps the id — for customs (upsert) and preset
      // overrides (same-id shadow) alike. The id override MUST spread
      // AFTER ...draft: getDraft() always mints a fresh custom-theme-<ts>
      // id, so a leading id would be silently clobbered and every save of
      // an existing scheme would fork a new row.
      const saved: HkCustomTheme = {
        ...draft,
        ...(target.value ? { id: target.value.id } : null),
      };
      theme.addCustomTheme(saved);
      theme.setTheme(saved.id);
      close();
    }

    const footerActions = computed<ModalAction[]>(() => [
      { label: t("settings.themeEditorCancel"), variant: "secondary", onClick: close },
      { label: t("settings.themeEditorSave"), variant: "primary", onClick: onSave },
    ]);

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={target.value ? t("settings.themeEditorEditTitle") : t("settings.themeEditorNewTitle")}
        width="36rem"
        footerActions={footerActions.value}
      >
        <HkColorSchemeEditor
          ref={editorRef}
          initialDark={target.value?.dark}
          initialLight={target.value?.light}
          initialGroups={target.value?.groups}
          initialName={target.value?.name ?? ""}
        />
        <p class="settings-modal__theme-editor-hint">{t("settings.themeEditorHint")}</p>
      </HkModal>
    );
  },
});
