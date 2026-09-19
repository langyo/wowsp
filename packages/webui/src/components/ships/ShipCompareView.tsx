import { computed, defineComponent, ref, watch } from "vue";
import { X } from "@lucide/vue";

import { HButton, HIconButton, HTag, HTabs, useToast } from "@celestia-island/hikari";

import NationFlag from "@/components/base/NationFlag";
import ShipPickerModal from "@/components/ships/ShipPickerModal";
import { COMPARE_GROUPS, groupApplies, tierLabel } from "@/utils/shipCompare";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import { nationNameFromDb } from "@/features/holographic/modelLoader";
import { type ShipInfo } from "@/api";
import { t } from "@/i18n";
import "./ShipCompareView.scss";

/**
 * Batch ship comparison (浩舰-style). A per-realm list of shipIds (persisted
 * to localStorage) renders as a single table with sticky identity columns
 * (remove / tier / name) on the left and one stat group at a time — picked
 * via the segmented tab strip — across the top.
 *
 * Ships are added through ShipPickerModal; the list dedupes and grows
 * unbounded. Ids the encyclopedia can no longer resolve (realm switch,
 * retired ships) are dropped on the next persist. Stat groups a hull can
 * never carry (no tubes, no ASW, no aircraft) collapse into one gray
 * "not applicable" cell instead of bare "—" gaps.
 */
export default defineComponent({
  name: "ShipCompareView",
  setup() {
    const encyclopedia = useEncyclopediaStore();
    const accounts = useAccountStore();
    const toast = useToast();

    const shipIds = ref<number[]>([]);
    const pickerOpen = ref(false);
    const groupKey = ref(COMPARE_GROUPS[0].key);
    const activeGroup = computed(
      () => COMPARE_GROUPS.find((g) => g.key === groupKey.value) ?? COMPARE_GROUPS[0],
    );

    // ── per-realm persistence ──────────────────────────────────────────
    function storageKey(): string {
      return `wowsp-ship-compare-${accounts.activeRealm}`;
    }

    function loadPersisted() {
      try {
        const raw = localStorage.getItem(storageKey());
        const parsed = raw ? JSON.parse(raw) : [];
        shipIds.value = Array.isArray(parsed)
          ? parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
          : [];
      } catch {
        // Corrupt payload — start clean rather than bricking the view.
        shipIds.value = [];
      }
    }
    loadPersisted();

    // Persist on every change, dropping ids the encyclopedia no longer
    // resolves; a realm switch swaps in that realm's own list.
    watch(
      () => [...shipIds.value],
      () => {
        const resolvable = shipIds.value.filter((id) => encyclopedia.byId.has(id));
        try {
          localStorage.setItem(storageKey(), JSON.stringify(resolvable));
        } catch {
          // Storage full/blocked — compare keeps working in-memory.
        }
      },
    );
    watch(() => accounts.activeRealm, loadPersisted);

    const ships = computed(() =>
      shipIds.value
        .map((id) => encyclopedia.byId.get(id))
        .filter((s): s is ShipInfo => s != null),
    );

    function removeShip(shipId: number) {
      shipIds.value = shipIds.value.filter((id) => id !== shipId);
    }

    /** Dedupe against the current list and append everything new (no cap);
     *  plain adds toast info, a no-op stays silent. */
    function addShips(list: ShipInfo[]) {
      const seen = new Set(shipIds.value);
      let addedCount = 0;
      for (const s of list) {
        if (seen.has(s.shipId)) continue;
        shipIds.value.push(s.shipId);
        seen.add(s.shipId);
        addedCount += 1;
      }
      if (addedCount > 0) {
        toast.info(t("ships.compare.addedToast", { n: addedCount }));
      }
    }

    function nationLabel(code: string): string {
      // Nation display names follow the 素材翻译 setting, same as the grid.
      return (
        nationNameFromDb(code, useLanguage().dataLanguage.value) ??
        (t(`ships.nation.${code}`, {}) || code)
      );
    }

    return () => {
      const group = activeGroup.value;
      return (
        <div class="ship-compare">
          {ships.value.length === 0 ? (
            <div class="ship-compare__empty">
              <p>{t("ships.compare.empty")}</p>
              <HButton size="sm" onClick={() => (pickerOpen.value = true)}>
                {t("ships.compare.addShips")}
              </HButton>
            </div>
          ) : (
            <>
              <div class="ship-compare__toolbar">
                <HButton size="sm" onClick={() => (pickerOpen.value = true)}>
                  {t("ships.compare.addShips")}
                </HButton>
                <HButton variant="secondary" size="sm" onClick={() => (shipIds.value = [])}>
                  {t("ships.compare.removeAll")}
                </HButton>
                <HTag variant="default" size="sm">
                  {t("ships.compare.count", { n: shipIds.value.length })}
                </HTag>
                <HTabs
                  class="ship-compare__groups"
                  variant="segmented"
                  modelValue={groupKey.value}
                  onUpdate:modelValue={(v: string) => (groupKey.value = v)}
                  tabs={COMPARE_GROUPS.map((g) => ({ key: g.key, label: t(g.labelKey) }))}
                />
              </div>

              {/* ── the compare table: identity columns sticky left,
                  header row sticky top ── */}
              <div class="ship-compare__scroll">
                <table class="ship-compare__table">
                  <thead>
                    <tr>
                      <th class="ship-compare__sticky ship-compare__sticky--remove" />
                      <th class="ship-compare__sticky ship-compare__sticky--tier">{t("ships.tier")}</th>
                      <th class="ship-compare__sticky ship-compare__sticky--name" />
                      {group.columns.map((c) => (
                        <th key={c.key}>{t(c.labelKey)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ships.value.map((s) => {
                      const profile = s.defaultProfile as Record<string, any> | null;
                      return (
                        <tr key={s.shipId}>
                          <td class="ship-compare__sticky ship-compare__sticky--remove">
                            {/* Slot content wins over the icon prop. */}
                            <HIconButton
                              size={24}
                              variant="ghost"
                              aria-label={t("ships.compare.remove")}
                              onClick={() => removeShip(s.shipId)}
                            >
                              <X size={16} />
                            </HIconButton>
                          </td>
                          <td class="ship-compare__sticky ship-compare__sticky--tier">
                            <HTag variant="primary" size="sm">{tierLabel(s.tier)}</HTag>
                          </td>
                          {/* The td must stay a table-cell (a flex td breaks
                              table layout → detached white block); the inner
                              div carries the flex row instead. */}
                          <td class="ship-compare__sticky ship-compare__sticky--name">
                            <div class="ship-compare__name-inner">
                              <NationFlag nation={s.nation} label={nationLabel(s.nation)} variant="flag" size="sm" />
                              <span class="ship-compare__ship-name">{encyclopedia.shipDisplayName(s)}</span>
                            </div>
                          </td>
                          {groupApplies(group, profile)
                            ? group.columns.map((c) => {
                                const value = c.get(profile, s.nation);
                                return <td key={c.key}>{value ?? "—"}</td>;
                              })
                            : (
                              <td key="na" class="ship-compare__na" colspan={group.columns.length}>
                                <HTag variant="default" size="sm">{t("ships.compare.notApplicable")}</HTag>
                              </td>
                            )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <ShipPickerModal
            modelValue={pickerOpen.value}
            onUpdate:modelValue={(v: boolean) => (pickerOpen.value = v)}
            existingIds={new Set(shipIds.value)}
            onAdd={(list: ShipInfo[]) => addShips(list)}
          />
        </div>
      );
    };
  },
});
