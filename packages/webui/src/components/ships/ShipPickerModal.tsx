import { computed, defineComponent, ref, watch, type PropType } from "vue";

import { HButton, HCheckbox, HLabel, HModal, HSearchInput, HTag } from "@celestia-island/hikari";

import NationFlag from "@/components/base/NationFlag";
import { tierLabel } from "@/utils/shipCompare";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import { nationNameFromDb } from "@/features/holographic/modelLoader";
import { type ShipInfo } from "@/api";
import { t } from "@/i18n";
import "./ShipPickerModal.scss";

/** Render cap for the result list — a loose filter can match half the
 *  encyclopedia and the DOM (plus HCheckbox instances) must stay small.
 *  The truncation is display-only: "add all" still covers every match. */
const RENDER_CAP = 150;
const TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/**
 * Batch ship picker for the compare mode. Unlike 水表查询's bundled tier
 * ranges, every filter chip here multi-selects individually; matching ships
 * list as checkbox rows and land in the compare table via the `add` event
 * (payload = ShipInfo[]). The modal stays open after adding — the parent
 * owns the toast feedback.
 *
 * `existingIds` marks ships already in the compare list: their rows render
 * an "Added" tag with a checked + disabled checkbox and are excluded from
 * both add actions.
 *
 * Clone hygiene is deliberately split in two: bracketed copy/event ships
 * ("[TS] Yamato") are hidden store-wide by the encyclopedia store's
 * `displayShips`, while "X2" WG data clones (蒙大拿2) whose base "X" also
 * exists are filtered in THIS modal only — the grid keeps showing them.
 */
export default defineComponent({
  name: "ShipPickerModal",
  props: {
    modelValue: { type: Boolean, default: false },
    /** ShipIds already in the parent's compare list. */
    existingIds: {
      type: Object as PropType<Set<number>>,
      default: () => new Set<number>(),
    },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    add: (_ships: ShipInfo[]) => true,
  },
  setup(props, { emit }) {
    const encyclopedia = useEncyclopediaStore();

    // ── filters (same matching semantics as the grid view) ────────────
    const searchText = ref("");
    const selectedTiers = ref<Set<number>>(new Set());
    const selectedTypes = ref<Set<string>>(new Set());
    const selectedNations = ref<Set<string>>(new Set());
    const checked = ref<Set<number>>(new Set());

    function toggleSet<T>(set: Set<T>, value: T): Set<T> {
      const next = new Set(set);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    }

    function nationLabel(code: string): string {
      // Nation display names follow the 素材翻译 setting, same as the grid.
      return (
        nationNameFromDb(code, useLanguage().dataLanguage.value) ??
        (t(`ships.nation.${code}`, {}) || code)
      );
    }

    function typeLabel(code: string): string {
      return t(`ships.type.${code}`, {}) || code;
    }

    /** Names that exist WITHOUT the trailing "2" — a "X2" ship whose base "X"
     *  is also a ship is a WG data clone ("蒙大拿2"). Matching on the base's
     *  existence keeps legitimate digit-suffixed names (T-22, Z-42) visible. */
    const cloneBases = computed(() => {
      const names = new Set<string>();
      for (const s of encyclopedia.displayShips) names.add(encyclopedia.shipDisplayName(s));
      return names;
    });

    const filteredShips = computed(() => {
      const q = searchText.value.trim().toLowerCase();
      return encyclopedia.displayShips.filter((s) => {
        if (selectedTiers.value.size > 0 && !selectedTiers.value.has(s.tier)) return false;
        if (selectedNations.value.size > 0 && !selectedNations.value.has(s.nation)) return false;
        if (selectedTypes.value.size > 0 && !selectedTypes.value.has(s.type)) return false;
        if (q && !s.name.toLowerCase().includes(q) && !encyclopedia.shipDisplayName(s).toLowerCase().includes(q)) return false;
        // Cheap checks first — the clone match only runs for survivors.
        const bare = encyclopedia.shipDisplayName(s);
        if (bare.endsWith("2") && cloneBases.value.has(bare.slice(0, -1))) return false;
        return true;
      });
    });

    const renderedShips = computed(() => filteredShips.value.slice(0, RENDER_CAP));
    const isTruncated = computed(() => filteredShips.value.length > RENDER_CAP);

    /** Ships not already in the compare list — the "add all" payload. */
    const addableShips = computed(() =>
      filteredShips.value.filter((s) => !props.existingIds.has(s.shipId)),
    );

    /** Checked ships resolvable to ShipInfo (survives filter changes). */
    const checkedShips = computed(() =>
      [...checked.value]
        .map((id) => encyclopedia.byId.get(id))
        .filter((s): s is ShipInfo => s != null),
    );

    function toggle(shipId: number) {
      checked.value = toggleSet(checked.value, shipId);
    }

    // Fresh selection every time the modal opens.
    watch(
      () => props.modelValue,
      (open) => {
        if (open) checked.value = new Set();
      },
    );

    /** Emit the payload and clear the selection; leave the modal open so a
     *  batch can be built incrementally — the parent toasts the result. */
    function emitAdd(ships: ShipInfo[]) {
      if (ships.length === 0) return;
      emit("add", ships);
      checked.value = new Set();
    }

    // Buttons live in HModal's named footer slot (a right-aligned strip
    // OUTSIDE the scroll body) — inside the default slot the footer used to
    // get clipped by .hk-modal-body's overflow when the list grew tall.
    return () => (
      <HModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("ships.compare.addShips")}
        width="40rem"
      >
        {{
          default: () => (
            <div class="ship-picker">
              <div class="ship-picker__filters">
                <div class="ship-picker__filter-group">
                  <HSearchInput
                    class="ship-picker__search"
                    size="sm"
                    modelValue={searchText.value}
                    onUpdate:modelValue={(v: string) => (searchText.value = v)}
                    placeholder={t("ships.search")}
                  />
                </div>

                <div class="ship-picker__filter-group">
                  <HLabel class="ship-picker__filter-label" text={t("ships.tier")} size="sm" />
                  <div class="ship-picker__chips">
                    {TIERS.map((tier) => (
                      <HCheckbox
                        key={tier}
                        size="sm"
                        label={String(tier)}
                        modelValue={selectedTiers.value.has(tier)}
                        onUpdate:modelValue={() => (selectedTiers.value = toggleSet(selectedTiers.value, tier))}
                      />
                    ))}
                  </div>
                </div>

                <div class="ship-picker__filter-group">
                  <HLabel class="ship-picker__filter-label" text={t("ships.filterType")} size="sm" />
                  <div class="ship-picker__chips">
                    {encyclopedia.types.map((tp) => (
                      <HCheckbox
                        key={tp}
                        size="sm"
                        label={typeLabel(tp)}
                        modelValue={selectedTypes.value.has(tp)}
                        onUpdate:modelValue={() => (selectedTypes.value = toggleSet(selectedTypes.value, tp))}
                      />
                    ))}
                  </div>
                </div>

                <div class="ship-picker__filter-group">
                  <HLabel class="ship-picker__filter-label" text={t("ships.filterNation")} size="sm" />
                  <div class="ship-picker__chips">
                    {encyclopedia.nations.map((n) => (
                      <HCheckbox
                        key={n}
                        size="sm"
                        label={nationLabel(n)}
                        modelValue={selectedNations.value.has(n)}
                        onUpdate:modelValue={() => (selectedNations.value = toggleSet(selectedNations.value, n))}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div class="ship-picker__list">
                {filteredShips.value.length === 0 ? (
                  <p class="ship-picker__empty">{t("ships.empty")}</p>
                ) : (
                  renderedShips.value.map((s) => {
                    const already = props.existingIds.has(s.shipId);
                    return (
                      <div
                        key={s.shipId}
                        class={["ship-picker__row", already ? "ship-picker__row--added" : ""]}
                        onClick={already ? undefined : (e) => {
                          // Clicks landing on the checkbox toggle via its own
                          // emit; the row handler skips them so they never
                          // cancel each other out.
                          if ((e.target as HTMLElement).closest(".hk-checkbox")) return;
                          toggle(s.shipId);
                        }}
                      >
                        <HCheckbox
                          size="sm"
                          modelValue={already || checked.value.has(s.shipId)}
                          disabled={already}
                          onUpdate:modelValue={() => toggle(s.shipId)}
                        />
                        <HTag variant="primary" size="sm">{tierLabel(s.tier)}</HTag>
                        <span class="ship-picker__name">{encyclopedia.shipDisplayName(s)}</span>
                        {already ? (
                          <HTag variant="info" size="sm">{t("ships.compare.added")}</HTag>
                        ) : null}
                        <HTag variant="default" size="sm">{typeLabel(s.type)}</HTag>
                        <NationFlag nation={s.nation} label={nationLabel(s.nation)} variant="flag" size="sm" />
                      </div>
                    );
                  })
                )}
              </div>
              {isTruncated.value ? (
                <p class="ship-picker__truncated">
                  {t("ships.compare.showing", {
                    shown: renderedShips.value.length,
                    total: filteredShips.value.length,
                  })}
                </p>
              ) : null}
            </div>
          ),
          footer: () => (
            <>
              <HButton
                variant="secondary"
                size="sm"
                disabled={addableShips.value.length === 0}
                onClick={() => emitAdd(addableShips.value)}
              >
                {t("ships.compare.addAll")}
              </HButton>
              <HButton
                size="sm"
                disabled={checkedShips.value.length === 0}
                onClick={() => emitAdd(checkedShips.value)}
              >
                {t("ships.compare.addSelected", { n: checkedShips.value.length })}
              </HButton>
            </>
          ),
        }}
      </HModal>
    );
  },
});
