import { computed, defineComponent, ref, watch } from "vue";
import { X } from "@lucide/vue";

import { HkButton, HkIconButton, HkScrollContainer, HkTag, HkTabs, useToast } from "@celestia-island/hikari";

import { api } from "@/api";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { shipCompareFits, type CompareShipFit } from "@/utils/shipCompareFits";

import NationFlag from "@/components/base/NationFlag";
import ShipPickerModal from "@/components/ships/ShipPickerModal";
import {
  COMPARE_GROUPS,
  groupApplies,
  tierLabel,
  type CompareColumn,
  type CompareProfile,
} from "@/utils/shipCompare";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import { nationNameFromDb } from "@/features/holographic/modelLoader";
import { type ShipInfo } from "@/api";
import { t } from "@/i18n";
import "./ShipCompareView.scss";

/** The toolbar armament filter's axis: everything / the stock
 *  (白板) configuration / the fully-upgraded configuration. */
type ArmamentFilter = "all" | "stock" | "top";

/**
 * Batch ship comparison (浩舰-style). A per-realm list of shipIds (persisted
 * to localStorage) renders as a single table with sticky identity columns
 * (remove / tier / name) on the left and one stat group at a time — picked
 * via the segmented tab strip — across the top.
 *
 * Ships are added through ShipPickerModal; the list dedupes and grows
 * unbounded. Ids the current branch source cannot resolve (the other
 * client's exclusive ships, retired hulls) persist but hide from the
 * table until they resolve again. Stat groups a hull can never carry
 * (no tubes, no ASW, no aircraft) collapse into one gray
 * "not applicable" cell instead of bare "—" gaps.
 *
 * Armament beyond the baseline: every weapon fit enumerates as an indented
 * sub-row (stock hull modules, alternate firing mode, torpedo alternates,
 * the ASW airstrike) and every embarked airframe as its own row grouped by
 * role — the aircraft group's identity row collapses into a "n aircraft
 * types" summary cell. Each row tags its configuration (白板/升级 chip);
 * the toolbar's armament filter (显示全部 / 只看基础武备 / 只看升级武备)
 * narrows the table to one configuration, with the identity row itself
 * stepping down to the stock fit's values under the base filter.
 */
export default defineComponent({
  name: "ShipCompareView",
  setup() {
    const encyclopedia = useEncyclopediaStore();
    const accounts = useAccountStore();
    const toast = useToast();
    const config = useConfigStore();
    const gameStatus = useGameStatusStore();
    const shipIds = ref<number[]>([]);
    const pickerOpen = ref(false);
    const groupKey = ref(COMPARE_GROUPS[0].key);
    const armamentFilter = ref<ArmamentFilter>("all");
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

    // Persist the full id list verbatim. Ids the current branch source
    // cannot resolve — the other client's exclusive ships while its side
    // of the WG/Lesta switch is off, retired hulls — only hide from the
    // table (the `ships` computed drops unresolvable ids at render), so
    // flipping the source back re-lights them instead of losing the
    // picks; a data realm switch swaps in that realm's own list.
    watch(
      () => [...shipIds.value],
      () => {
        try {
          localStorage.setItem(storageKey(), JSON.stringify(shipIds.value));
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

    // ── per-ship GameParams (weapon-fit variants) ───────────────────────
    // The baseline row reads the WG default_profile (fully-upgraded ship,
    // standard ammo). Weapon-fit sub-rows (alternate firing mode, stock
    // hull fits, researchable torpedo alternates) and the ASW airstrike
    // need the per-ship GameParams slice — fetched lazily per compared
    // hull, the same resolve-set discipline the lineup editor uses.
    // Failures (no install, web build, slice-less hulls) simply leave a
    // ship at its baseline row; the AIRCRAFT rows survive it (the baked
    // squadron seed answers offline).
    const gameRoot = computed(
      () => config.activeInstall?.path ?? gameStatus.process.matchedInstall?.path ?? "",
    );
    const gameparamsByShip = ref(new Map<number, unknown>());
    const gameparamsPending = new Set<number>();

    function loadGameparams(): void {
      const root = gameRoot.value;
      if (!root) return;
      for (const s of ships.value) {
        if (gameparamsByShip.value.has(s.shipId) || gameparamsPending.has(s.shipId)) continue;
        gameparamsPending.add(s.shipId);
        api
          .getShipGameparams(s.shipId, root)
          .then((gp) => {
            const next = new Map(gameparamsByShip.value);
            next.set(s.shipId, gp);
            gameparamsByShip.value = next;
          })
          .catch(() => {
            // no slice for this hull — the baseline row stays alone
          });
      }
    }
    watch([ships, gameRoot], loadGameparams, { immediate: true });

    const fitsByShip = computed(() => {
      const out = new Map<number, CompareShipFit[]>();
      for (const s of ships.value) {
        const gp = gameparamsByShip.value.get(s.shipId);
        out.set(
          s.shipId,
          shipCompareFits(s.defaultProfile as CompareProfile | null, s.nation, gp, s.shipId),
        );
      }
      return out;
    });


    function nationLabel(code: string): string {
      // Nation display names follow the 素材翻译 setting, same as the grid.
      return (
        nationNameFromDb(code, useLanguage().dataLanguage.value) ??
        (t(`ships.nation.${code}`, {}) || code)
      );
    }

    return () => {
      const group = activeGroup.value;
      const filterTabs: { key: ArmamentFilter; label: string }[] = [
        { key: "all", label: t("ships.compare.filter.all") },
        { key: "stock", label: t("ships.compare.filter.stock") },
        { key: "top", label: t("ships.compare.filter.top") },
      ];
      return (
        <div class="ship-compare">
          {ships.value.length === 0 ? (
            <div class="ship-compare__empty">
              <p>{t("ships.compare.empty")}</p>
              <HkButton size="sm" onClick={() => (pickerOpen.value = true)}>
                {t("ships.compare.addShips")}
              </HkButton>
            </div>
          ) : (
            <>
              <div class="ship-compare__toolbar">
                <HkButton size="sm" onClick={() => (pickerOpen.value = true)}>
                  {t("ships.compare.addShips")}
                </HkButton>
                <HkButton variant="secondary" size="sm" onClick={() => (shipIds.value = [])}>
                  {t("ships.compare.removeAll")}
                </HkButton>
                <HkTag variant="default" size="sm">
                  {t("ships.compare.count", { n: shipIds.value.length })}
                </HkTag>
                {/* Armament-configuration filter: the baseline row always
                    speaks for the fully-upgraded ship, so the stock view
                    steps the identity cells down to the stock fit's values
                    (see stockOverride below) instead of keeping two rows
                    that would read as duplicates. */}
                <HkTabs
                  class="ship-compare__filter"
                  variant="segmented"
                  modelValue={armamentFilter.value}
                  onUpdate:modelValue={(v: string) => (armamentFilter.value = v as ArmamentFilter)}
                  tabs={filterTabs}
                />
                <HkTabs
                  class="ship-compare__groups"
                  variant="segmented"
                  modelValue={groupKey.value}
                  onUpdate:modelValue={(v: string) => (groupKey.value = v)}
                  tabs={COMPARE_GROUPS.map((g) => ({ key: g.key, label: t(g.labelKey) }))}
                />
              </div>

              {/* ── the compare table: identity columns sticky left,
                  header row sticky top. Both axes scroll through hikari's
                  scroll container (overlay thumbs; native bars hidden). ── */}
              <HkScrollContainer class="ship-compare__scroll" axis="both">
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
                    {ships.value.flatMap((s) => {
                      const profile = s.defaultProfile as CompareProfile | null;
                      const allFits = fitsByShip.value.get(s.shipId) ?? [];
                      const planeCount = allFits.filter((f) => f.kind === "aircraft").length;
                      // Applicability reads the enumerated fits, not the raw
                      // sources: an airframe without baked specs yields no
                      // row, so the summary cell can never announce a count
                      // the table does not show.
                      const extra = {
                        hasPlanes: planeCount > 0,
                        hasAirstrike: allFits.some((f) => f.kind === "asw-airstrike"),
                      };
                      const applies = groupApplies(group, profile, extra);
                      // Weapon-fit sub-rows visible under the current
                      // armament filter, computed before the identity row
                      // (the aircraft summary cell announces this same
                      // list, so the count never drifts from the rows):
                      //  - "all": every fit of the group;
                      //  - "stock": base airframes as rows; the stock
                      //    hull/artillery/torpedo fits speak through the
                      //    identity row's stepped-down cells instead, and a
                      //    "both" weapon (the ASW airstrike) rows only when
                      //    the identity cells do not already speak for it;
                      //  - "top": everything the fully-upgraded ship owns —
                      //    its own extras plus the "both" weapons (the
                      //    stock-view identity no longer carries them
                      //    there).
                      // The baseline's own answer for this group — a
                      // "both" weapon only steps over it when the WG
                      // profile carries nothing (airstrike-only hulls).
                      const baselineHasValues = applies && group.key !== "aircraft"
                        ? group.columns.some((c) => c.get(profile, s.nation) != null)
                        : false;
                      // Stock view: the group's identity cells step down to
                      // the stock configuration's values — the base fits
                      // first, then the configuration-invariant "both"
                      // weapons (the stock hull carries the identical ASW
                      // airstrike), and only when the WG baseline has
                      // nothing to say (fit-first; columns the fit cannot
                      // answer read as em dashes). Groups without any of
                      // those keep the baseline — identical on both.
                      const stockOverride =
                        armamentFilter.value === "stock"
                          ? (allFits.find(
                              (f) =>
                                f.variant === "base" &&
                                f.kind !== "aircraft" &&
                                f.groupKeys.includes(group.key),
                            ) ??
                            (baselineHasValues
                              ? null
                              : allFits.find(
                                  (f) =>
                                    f.variant === "both" &&
                                    f.kind !== "aircraft" &&
                                    f.groupKeys.includes(group.key),
                                ) ?? null))
                          : null;
                      const visibleFits = applies
                        ? allFits.filter((fit) => {
                            if (!fit.groupKeys.includes(group.key)) return false;
                            if (armamentFilter.value === "stock") {
                              // Base airframes as rows; a "both" weapon rows
                              // too UNLESS the identity cells speak for it
                              // (airstrike-only hulls — no duplicate row).
                              return (
                                (fit.kind === "aircraft" && fit.variant === "base") ||
                                (fit.variant === "both" && fit !== stockOverride)
                              );
                            }
                            if (armamentFilter.value === "top") return fit.variant !== "base";
                            return true;
                          })
                        : [];
                      const cellValue = (c: CompareColumn): string | null =>
                        stockOverride
                          ? c.key in stockOverride.values
                            ? stockOverride.values[c.key]
                            : null
                          : c.get(profile, s.nation);
                      const mainRow = (
                        <tr key={s.shipId}>
                          <td class="ship-compare__sticky ship-compare__sticky--remove">
                            {/* Slot content wins over the icon prop. */}
                            <HkIconButton
                              size={24}
                              variant="ghost"
                              aria-label={t("ships.compare.remove")}
                              onClick={() => removeShip(s.shipId)}
                            >
                              <X size={16} />
                            </HkIconButton>
                          </td>
                          <td class="ship-compare__sticky ship-compare__sticky--tier">
                            <HkTag variant="primary" size="sm">{tierLabel(s.tier)}</HkTag>
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
                          {!applies ? (
                            <td key="na" class="ship-compare__na" colspan={group.columns.length}>
                              <HkTag variant="default" size="sm">{t("ships.compare.notApplicable")}</HkTag>
                            </td>
                          ) : group.key === "aircraft" ? (
                            // A carrier's air wing is a SET of squadrons, not
                            // one stat — the identity row summarizes and the
                            // per-airframe sub-rows carry the numbers. The
                            // count mirrors the visible sub-rows below (the
                            // filter-aware list), never the unfiltered wing.
                            <td key="aircraft" class="ship-compare__summary" colspan={group.columns.length}>
                              <HkTag variant="primary" size="sm">
                                {t("ships.compare.planesSummary", {
                                  n: visibleFits.filter((f) => f.kind === "aircraft").length,
                                })}
                              </HkTag>
                            </td>
                          ) : (
                            group.columns.map((c) => (
                              <td key={c.key}>{cellValue(c) ?? "—"}</td>
                            ))
                          )}
                        </tr>
                      );
                      const fitRows = visibleFits.map((fit) => (
                        <tr key={s.shipId + ":" + fit.key} class="ship-compare__fit-row">
                          <td class="ship-compare__sticky ship-compare__sticky--remove" />
                          <td class="ship-compare__sticky ship-compare__sticky--tier" />
                          <td class="ship-compare__sticky ship-compare__sticky--name">
                            <div class="ship-compare__fit-inner">
                              <span class="ship-compare__fit-label">{t(fit.labelKey)}</span>
                              {fit.chip ? (
                                <HkTag
                                  variant={fit.variant === "base" ? "default" : "primary"}
                                  size="sm"
                                  class="ship-compare__fit-chip"
                                >
                                  {t(fit.variant === "base" ? "ships.compare.variant.base" : "ships.compare.variant.top")}
                                </HkTag>
                              ) : null}
                              {fit.suffix ? (
                                // data-hint carries the full text (the cell
                                // ellipsizes long airframe designations).
                                <span class="ship-compare__fit-suffix" data-hint={fit.suffix}>
                                  {fit.suffix}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          {group.columns.map((c) => {
                            const value = fit.values[c.key] ?? null;
                            return (
                              <td key={c.key} class={value == null ? "ship-compare__fit-blank" : undefined}>
                                {value ?? "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ));
                      return [mainRow, ...fitRows];
                    })}
                  </tbody>
                </table>
              </HkScrollContainer>
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
