import { computed, defineComponent, nextTick, ref, watch, type PropType } from "vue";
import {
  HkColorSchemeEditor,
  HkIconButton,
  HkModal,
  themePresets,
  useTheme,
  type HkCustomTheme,
  type ModalAction,
  type ThemePreset,
} from "@celestia-island/hikari";
import { RotateCcw } from "@lucide/vue";

import { t } from "@/i18n";
import {
  applyShipGroupDraft,
  shipGroupOverrides,
  stripShipGroupDraft,
  syncShipTypeTokenGroup,
} from "@/theme/shipTypeTokenGroup";
import { resetShipTypeColors } from "@/theme/shipTypeColors";

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
 * The ship-type pie palette rides the editor's extension-group grammar as
 * the "ship types" panel (theme/shipTypeTokenGroup): the group is
 * registered/refreshed here — at setup and on every open, so a locale
 * switch relabels it — and its panel always prefills from the global
 * per-mode store, never from the edit target's saved groups. Saving writes
 * the ship slots back to the store and strips the group from the persisted
 * scheme (the palette is a preference, not per-scheme data).
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

    // Register the ship-type group before the editor first mounts (its
    // draft seeds from the registry); re-registered on every open below.
    syncShipTypeTokenGroup();

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

    /** Editor prefill for the extension groups: the target's own saved
     *  groups (presets/customs rarely carry any) with the ship-type panel
     *  OVERRIDDEN from the live store — the panel edits the global
     *  palette in both modes, whatever scheme is being edited. */
    const initialGroups = computed(() => ({
      dark: { ...(target.value?.groups?.dark ?? {}), ...shipGroupOverrides("dark") },
      light: { ...(target.value?.groups?.light ?? {}), ...shipGroupOverrides("light") },
    }));

    // Re-seed on every open so the editor replays the (possibly changed)
    // prefills and follows the current effective mode — reset() is the
    // editor's documented open-time entry point.
    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          syncShipTypeTokenGroup();
          void nextTick(() => editorRef.value?.reset());
        }
      },
    );

    function close() {
      emit("update:modelValue", false);
    }

    function onSave() {
      const draft = editorRef.value?.getDraft();
      if (!draft) return;
      // Ship palette first: the editor's ship slots ARE the global store
      // edit — write it, and refresh the registry defaults so preset-side
      // resolution (and the CSS vars) match what was just saved.
      applyShipGroupDraft(draft);
      syncShipTypeTokenGroup();
      // In-place edit keeps the id — for customs (upsert) and preset
      // overrides (same-id shadow) alike. The id override MUST spread
      // AFTER ...draft: getDraft() always mints a fresh custom-theme-<ts>
      // id, so a leading id would be silently clobbered and every save of
      // an existing scheme would fork a new row. The ship group is
      // stripped from what persists: it is a store-backed preference, and
      // the panel reseeds from the store on the next open. When stripping
      // leaves nothing, the key is DELETED — the earlier ...draft spread
      // would otherwise keep the full draft groups (ship group included)
      // on saved.
      const groups = stripShipGroupDraft(draft.groups ?? {});
      const saved: HkCustomTheme = {
        ...draft,
        ...(target.value ? { id: target.value.id } : null),
      };
      if (groups) {
        saved.groups = groups;
      } else {
        delete saved.groups;
      }
      theme.addCustomTheme(saved);
      theme.setTheme(saved.id);
      close();
    }

    /** Restore the factory ship palette: reset the store, refresh the
     *  registry (slot defaults follow the store), then reseed the editor
     *  draft — on the NEXT tick, so reset() reads the already-rerendered
     *  initialGroups prop rather than the stale pre-reset object. The
     *  reseed replays the whole prefill (accent tokens included), which is
     *  the editor's only public reseed entry point. */
    function onResetShipColors() {
      resetShipTypeColors();
      syncShipTypeTokenGroup();
      void nextTick(() => editorRef.value?.reset());
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
          initialGroups={initialGroups.value}
          initialName={target.value?.name ?? ""}
        />
        <p class="settings-modal__theme-editor-hint">{t("settings.themeEditorHint")}</p>
        <div class="settings-modal__theme-editor-ship">
          <span class="settings-modal__theme-editor-ship-hint">
            {t("settings.shipTypeColorsHint")}
          </span>
          <HkIconButton
            size={24}
            variant="ghost"
            aria-label={t("settings.shipTypeColorsReset")}
            onClick={onResetShipColors}
          >
            <RotateCcw size={14} />
          </HkIconButton>
        </div>
      </HkModal>
    );
  },
});
