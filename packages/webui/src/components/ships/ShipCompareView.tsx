import { computed, defineComponent, ref, watch } from "vue";
import { X } from "@lucide/vue";

import { HButton, HTag, HTabs, useToast } from "@celestia-island/hikari";

import NationFlag from "@/components/base/NationFlag";
import ShipPickerModal from "@/components/ships/ShipPickerModal";
import { COMPARE_GROUPS, MAX_COMPARE_SHIPS } from "@/utils/shipCompare";
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
 * Ships are added through ShipPickerModal; the list dedupes and caps at
 * MAX_COMPARE_SHIPS with toast feedback. Ids the encyclopedia can no longer
 * resolve (realm switch, retired ships) are dropped on the next persist.
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

    /** Dedupe against the current list, append up to the cap, and toast the
     *  outcome (cap hits warn, plain adds info, no-op stays silent). */
    function addShips(list: ShipInfo[]) {
      const seen = new Set(shipIds.value);
      let addedCount = 0;
      let droppedByCap = false;
      for (const s of list) {
        if (seen.has(s.shipId)) continue;
        if (shipIds.value.length >= MAX_COMPARE_SHIPS) {
          droppedByCap = true;
          break;
        }
        shipIds.value.push(s.shipId);
        seen.add(s.shipId);
        addedCount += 1;
      }
      if (droppedByCap) {
        toast.warning(t("ships.compare.cap", { n: MAX_COMPARE_SHIPS }));
      } else if (addedCount > 0) {
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
                  {t("ships.compare.count", { n: shipIds.value.length, max: MAX_COMPARE_SHIPS })}
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
                    {ships.value.map((s) => (
                      <tr key={s.shipId}>
                        <td class="ship-compare__sticky ship-compare__sticky--remove">
                          <button
                            class="ship-compare__remove"
                            onClick={() => removeShip(s.shipId)}
                          >
                            <X size={14} />
                          </button>
                        </td>
                        <td class="ship-compare__sticky ship-compare__sticky--tier">
                          <span class="ship-compare__tier">T{s.tier}</span>
                        </td>
                        <td class="ship-compare__sticky ship-compare__sticky--name">
                          <NationFlag nation={s.nation} label={nationLabel(s.nation)} variant="flag" size="sm" />
                          <span class="ship-compare__ship-name">{encyclopedia.shipDisplayName(s)}</span>
                        </td>
                        {group.columns.map((c) => {
                          const value = c.get(
                            s.defaultProfile as Record<string, any> | null,
                            s.nation,
                          );
                          return <td key={c.key}>{value ?? "—"}</td>;
                        })}
                      </tr>
                    ))}
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
