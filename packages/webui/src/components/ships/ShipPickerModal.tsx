import { computed, defineComponent, ref, watch, type PropType } from "vue";

import { HkButton, HkCheckbox, HkModal, HkSearchInput, HkTag } from "@celestia-island/hikari";

import NationFlag from "@/components/base/NationFlag";
import FilterCategoryChip from "@/components/ships/FilterCategoryChip";
import { tierLabel } from "@/utils/shipCompare";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import { nationNameFromDb } from "@/features/holographic/modelLoader";
import { type ShipInfo } from "@/api";
import { t } from "@/i18n";
import "./ShipPickerModal.scss";

/** Render cap for the result list — a loose filter can match half the
 *  encyclopedia and the DOM (plus HkCheckbox instances) must stay small.
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
    // Tier/type/nation selections are string sets so they feed the
    // FilterCategoryChip props unchanged.
    const searchText = ref("");
    const selectedTiers = ref<Set<string>>(new Set());
    const selectedTypes = ref<Set<string>>(new Set());
    const selectedNations = ref<Set<string>>(new Set());
    const checked = ref<Set<number>>(new Set());
    // Which category's popup is open — one at a time, owned here so opening
    // one chip closes the others (mirrors ShipFilterBar's single-open row).
    const openCat = ref<string | null>(null);

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

    // Chip option lists — derived from the store so a realm switch re-derives
    // them; canonical order matches the old checkbox rows (tiers I–★).
    const tierOptions = computed(() => TIERS.map((n) => ({ value: String(n), label: tierLabel(n) })));
    const typeOptions = computed(() => encyclopedia.types.map((tp) => ({ value: tp, label: typeLabel(tp) })));
    const nationOptions = computed(() => encyclopedia.nations.map((n) => ({ value: n, label: nationLabel(n) })));

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
        if (selectedTiers.value.size > 0 && !selectedTiers.value.has(String(s.tier))) return false;
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
        if (open) {
          checked.value = new Set();
          // No popup should survive a close/reopen either.
          openCat.value = null;
        }
      },
    );

    /** Emit the payload and clear the selection; leave the modal open so a
     *  batch can be built incrementally — the parent toasts the result. */
    function emitAdd(ships: ShipInfo[]) {
      if (ships.length === 0) return;
      emit("add", ships);
      checked.value = new Set();
    }

    // Buttons live in HkModal's named footer slot (a right-aligned strip
    // OUTSIDE the scroll body) — inside the default slot the footer used to
    // get clipped by .hk-modal-body's overflow when the list grew tall.
    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("ships.compare.addShips")}
        width="40rem"
      >
        {{
          default: () => (
            <div class="ship-picker">
              {/* Filter toolbar mirrors the 水表查询 bar: collapsed category
                  chips (single-open, state owned here) + a stretching search
                  on the same row. The last chip opens leftwards so its popup
                  never escapes the modal edge. */}
              <div class="ship-picker__toolbar">
                <FilterCategoryChip
                  title={t("ships.filter.tierTitle")}
                  allLabel={t("ships.filter.tierAll")}
                  options={tierOptions.value}
                  selected={selectedTiers.value}
                  open={openCat.value === "tier"}
                  onUpdate:open={(v: boolean) => (openCat.value = v ? "tier" : null)}
                  onToggle={(v: string) => (selectedTiers.value = toggleSet(selectedTiers.value, v))}
                  onClear={() => (selectedTiers.value = new Set())}
                />
                <FilterCategoryChip
                  title={t("ships.filter.typeTitle")}
                  allLabel={t("ships.filter.typeAll")}
                  options={typeOptions.value}
                  selected={selectedTypes.value}
                  open={openCat.value === "type"}
                  onUpdate:open={(v: boolean) => (openCat.value = v ? "type" : null)}
                  onToggle={(v: string) => (selectedTypes.value = toggleSet(selectedTypes.value, v))}
                  onClear={() => (selectedTypes.value = new Set())}
                />
                <FilterCategoryChip
                  title={t("ships.filter.nationTitle")}
                  allLabel={t("ships.filter.nationAll")}
                  options={nationOptions.value}
                  selected={selectedNations.value}
                  open={openCat.value === "nation"}
                  onUpdate:open={(v: boolean) => (openCat.value = v ? "nation" : null)}
                  onToggle={(v: string) => (selectedNations.value = toggleSet(selectedNations.value, v))}
                  onClear={() => (selectedNations.value = new Set())}
                  edge
                />
                <HkSearchInput
                  class="ship-picker__search"
                  size="sm"
                  modelValue={searchText.value}
                  onUpdate:modelValue={(v: string) => (searchText.value = v)}
                  placeholder={t("ships.search")}
                />
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
                        <HkCheckbox
                          size="sm"
                          modelValue={already || checked.value.has(s.shipId)}
                          disabled={already}
                          onUpdate:modelValue={() => toggle(s.shipId)}
                        />
                        <HkTag variant="primary" size="sm">{tierLabel(s.tier)}</HkTag>
                        <span class="ship-picker__name">{encyclopedia.shipDisplayName(s)}</span>
                        {already ? (
                          <HkTag variant="info" size="sm">{t("ships.compare.added")}</HkTag>
                        ) : null}
                        <HkTag variant="default" size="sm">{typeLabel(s.type)}</HkTag>
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
              <HkButton
                variant="secondary"
                size="sm"
                disabled={addableShips.value.length === 0}
                onClick={() => emitAdd(addableShips.value)}
              >
                {t("ships.compare.addAll")}
              </HkButton>
              <HkButton
                size="sm"
                disabled={checkedShips.value.length === 0}
                onClick={() => emitAdd(checkedShips.value)}
              >
                {t("ships.compare.addSelected", { n: checkedShips.value.length })}
              </HkButton>
            </>
          ),
        }}
      </HkModal>
    );
  },
});
