import { computed, defineComponent, ref, watch } from "vue";
import { AlertTriangle, RotateCcw } from "lucide-vue-next";

import SSelect from "@/components/base/SSelect";
import SButton from "@/components/base/SButton";
import SSegmented from "@/components/base/SSegmented";
import SSpinner from "@/components/base/SSpinner";
import STag from "@/components/base/STag";
import NationFlag from "@/components/base/NationFlag";
import TechTreeView from "@/components/ships/TechTreeView";
import { resolveShipImage } from "@/utils/shipImages";
import { useAccountStore } from "@/stores/account";
import { useConfigStore } from "@/stores/config";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useShipStatsStore } from "@/stores/shipStats";
import { useToast } from "@/composables/useToast";
import { useTrendsStore } from "@/stores/trends";
import { type ShipInfo } from "@/api";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
import { shipRarity, RARITY_VARIANT, RARITY_CARD_MOD, RARITY_ORDER, type Rarity } from "@/utils/shipRarity";
import { SHIP_TYPE_SHORT } from "@/utils/shipAggregation";
import ShipDetailModal from "@/components/ships/ShipDetailModal";
import "./ShipsView.scss";

/**
 * Ship encyclopedia browser (4th sidebar tab). Top filter bar (nation/type/
 * tier/search) → responsive card grid → click a card opens the detail modal
 * with 4 tabs (Specs / Armor / My Stats / Community trend).
 *
 * Data flows: encyclopedia store (ships list) + shipStats store (per-player
 * per-ship battles, shown on cards when an account is bound) + config store
 * (game root path, needed for GameParams extraction).
 */
export default defineComponent({
  name: "ShipsView",
  setup() {
    const encyclopedia = useEncyclopediaStore();
    const shipStats = useShipStatsStore();
    const trends = useTrendsStore();
    const accounts = useAccountStore();
    const config = useConfigStore();
    const toast = useToast();

    // ── realm picker + load ────────────────────────────────────────────
    const realm = ref(accounts.activeRealm || "asia");
    const realms = ["ru", "eu", "na", "asia"];

    // ── view mode (tech-tree vs list) ─────────────────────────────────
    const viewMode = ref<"tree" | "grid">("tree");
    const treeNation = ref<string>("");
    /** True once the first load attempt completes (success or fail). */
    const firstLoadDone = ref(false);

    async function loadEncyclopedia(force = false) {
      const toastId = toast.loading(t("ships.loading"));
      await encyclopedia.load(realm.value, force);
      toast.dismiss(toastId);
      firstLoadDone.value = true;
      if (!treeNation.value && encyclopedia.nations.length > 0) {
        treeNation.value = encyclopedia.nations[0];
      }
      const acc = accounts.activeAccount;
      if (acc) {
        void shipStats.load(acc.accountId, acc.realm).catch(() => {});
      }
    }

    // Auto-load on mount if not already loaded for this realm.
    if (encyclopedia.ships.length === 0) {
      void loadEncyclopedia();
    }
    // Reload when realm changes.
    watch(realm, () => void loadEncyclopedia());

    // Fallback: if encyclopedia loads while treeNation is still blank, pick first.
    watch(() => encyclopedia.nations, (n) => {
      if (!treeNation.value && n.length > 0) {
        treeNation.value = n[0];
      }
    });

    // ── filters ────────────────────────────────────────────────────────
    const searchText = ref("");
    const selectedNations = ref<Set<string>>(new Set());
    const selectedTypes = ref<Set<string>>(new Set());
    const selectedTiers = ref<Set<number>>(new Set());
    const selectedRarities = ref<Set<Rarity>>(new Set());

    function toggleSet<T>(set: Set<T>, value: T): Set<T> {
      const next = new Set(set);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    }

    /** Reset all filters to their empty state. */
    function clearFilters() {
      searchText.value = "";
      selectedNations.value = new Set();
      selectedTypes.value = new Set();
      selectedTiers.value = new Set();
      selectedRarities.value = new Set();
    }

    const hasActiveFilters = computed(
      () =>
        searchText.value.trim() !== "" ||
        selectedNations.value.size > 0 ||
        selectedTypes.value.size > 0 ||
        selectedTiers.value.size > 0 ||
        selectedRarities.value.size > 0,
    );

    const filteredShips = computed(() => {
      const q = searchText.value.trim().toLowerCase();
      return encyclopedia.displayShips.filter((s) => {
        if (selectedTiers.value.size > 0 && !selectedTiers.value.has(s.tier)) return false;
        if (selectedNations.value.size > 0 && !selectedNations.value.has(s.nation)) return false;
        if (selectedTypes.value.size > 0 && !selectedTypes.value.has(s.type)) return false;
        if (selectedRarities.value.size > 0 && !selectedRarities.value.has(shipRarity(s))) return false;
        if (q && !s.name.toLowerCase().includes(q) && !encyclopedia.shipDisplayName(s).toLowerCase().includes(q)) return false;
        return true;
      });
    });

    // ── detail modal ───────────────────────────────────────────────────
    const selectedShip = ref<ShipInfo | null>(null);
    const gameRoot = computed(() => config.activeInstall?.path ?? "");

    /** Encyclopedia ships keyed by shipId, for the tech-tree resolver. */
    const shipsById = computed(() => {
      const m = new Map<number, ShipInfo>();
      for (const s of encyclopedia.ships) m.set(s.shipId, s);
      return m;
    });

    function openDetail(ship: ShipInfo) {
      selectedShip.value = ship;
      // Preload community trend for the modal's "Server Trend" tab.
      void trends.loadCommunity(ship.shipId);
    }

    // ── card helpers ───────────────────────────────────────────────────
    function shipBattles(shipId: number): number | null {
      const acc = accounts.activeAccount;
      if (!acc) return null;
      const s = shipStats.getShip(acc.accountId, acc.realm, shipId);
      return s?.battles ?? null;
    }

    function shipWr(shipId: number): number | null {
      const acc = accounts.activeAccount;
      if (!acc) return null;
      const s = shipStats.getShip(acc.accountId, acc.realm, shipId);
      return s?.winrate ?? null;
    }

    function hp(ship: ShipInfo): number | null {
      const dp = ship.defaultProfile as { hull?: { health?: number } } | null;
      return dp?.hull?.health ?? null;
    }

    function concealment(ship: ShipInfo): number | null {
      const dp = ship.defaultProfile as { concealment?: { detectDistanceByShip?: number } } | null;
      return dp?.concealment?.detectDistanceByShip ?? null;
    }

    function speed(ship: ShipInfo): number | null {
      const dp = ship.defaultProfile as { mobility?: { maxSpeed?: number } } | null;
      return dp?.mobility?.maxSpeed ?? null;
    }

    function nationLabel(code: string): string {
      return t(`ships.nation.${code}`, {}) || code;
    }

    function typeLabel(code: string): string {
      return t(`ships.type.${code}`, {}) || code;
    }

    return () => (
      <div class="ships-view">
        <header class="ships-view__header">
          <h1 class="ships-view__title">{t("ships.title")}</h1>
          <div class="ships-view__header-right">
            <SSegmented
              modelValue={viewMode.value}
              onUpdate:modelValue={(v: string) => (viewMode.value = v as "tree" | "grid")}
              options={[
                { value: "tree", label: t("ships.viewMode.tree") },
                { value: "grid", label: t("ships.viewMode.grid") },
              ]}
            />
            <div class="ships-view__realm">
              <SSelect
                size="sm"
                modelValue={realm.value}
                onUpdate:modelValue={(v: string) => (realm.value = v)}
                options={realms.map((r) => ({ value: r, label: r.toUpperCase() }))}
              />
              <SButton variant="secondary" size="sm" onClick={() => void loadEncyclopedia(true)}>
                <RotateCcw size={12} /> {t("ships.reload")}
              </SButton>
            </div>
          </div>
        </header>

        {encyclopedia.version ? (
          <div class="ships-view__meta">
            <span>
              {t("ships.versionLabel")}: <strong>{encyclopedia.version.gameVersion}</strong>
            </span>
            <span>{t("ships.shipsCount", { n: filteredShips.value.length })}</span>
          </div>
        ) : null}

        {/* ── error banner (shown above content when data already exists) ── */}
        {encyclopedia.error && encyclopedia.ships.length > 0 ? (
          <div class="ships-view__error-banner">
            <AlertTriangle size={16} />
            <span>{encyclopedia.error}</span>
            <SButton variant="secondary" size="sm" onClick={() => void loadEncyclopedia(true)}>
              <RotateCcw size={12} /> {t("ships.retry")}
            </SButton>
          </div>
        ) : null}

        {/* ── scrollable content body ── */}
        <div class="ships-view__body">

        {/* ── loading state ── */}
        {encyclopedia.loading && encyclopedia.ships.length === 0 ? (
          <div class="ships-view__status"><SSpinner center size="md" /></div>
        ) : null}

        {/* ── filter bar (grid mode only, sticky inside scroll body) ── */}
        {viewMode.value === "tree" ? null : (
          <div class="ships-view__filters">
            <div class="ships-view__filter-top">
              <input
                class="ships-view__search"
                type="text"
                placeholder={t("ships.search")}
                value={searchText.value}
                onInput={(e) => (searchText.value = (e.target as HTMLInputElement).value)}
              />
              {hasActiveFilters.value ? (
                <button class="ships-view__clear" onClick={() => clearFilters()}>
                  {t("ships.clear")}
                </button>
              ) : null}
            </div>

            <div class="ships-view__filter-group">
              <span class="ships-view__filter-label">{t("ships.tier")}</span>
              <div class="ships-view__chips">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((tier) => (
                  <button
                    class={[
                      "ships-view__chip",
                      "ships-view__chip--tier",
                      selectedTiers.value.has(tier) ? "ships-view__chip--on" : "",
                    ]}
                    onClick={() => (selectedTiers.value = toggleSet(selectedTiers.value, tier))}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            </div>

            <div class="ships-view__filter-group">
              <span class="ships-view__filter-label">{t("ships.filterType")}</span>
              <div class="ships-view__chips">
                {encyclopedia.types.map((tp) => (
                  <button
                    class={[
                      "ships-view__chip",
                      selectedTypes.value.has(tp) ? "ships-view__chip--on" : "",
                    ]}
                    onClick={() => (selectedTypes.value = toggleSet(selectedTypes.value, tp))}
                  >
                    {typeLabel(tp)}
                  </button>
                ))}
              </div>
            </div>

            <div class="ships-view__filter-group">
              <span class="ships-view__filter-label">{t("ships.filterNation")}</span>
              <div class="ships-view__chips">
                {encyclopedia.nations.map((n) => (
                  <button
                    class={[
                      "ships-view__chip",
                      selectedNations.value.has(n) ? "ships-view__chip--on" : "",
                    ]}
                    onClick={() => (selectedNations.value = toggleSet(selectedNations.value, n))}
                  >
                    {nationLabel(n)}
                  </button>
                ))}
              </div>
            </div>

            <div class="ships-view__filter-group">
              <span class="ships-view__filter-label">{t("ships.rarity._label")}</span>
              <div class="ships-view__chips">
                {RARITY_ORDER.map((r) => (
                  <button
                    class={[
                      "ships-view__chip",
                      `ships-view__chip--${r}`,
                      selectedRarities.value.has(r) ? "ships-view__chip--on" : "",
                    ]}
                    onClick={() => (selectedRarities.value = toggleSet(selectedRarities.value, r))}
                  >
                    {t(`ships.rarity.${r}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── view body: tree or grid ── */}
        <Transition name="s-fade-slide" mode="out-in">
          {encyclopedia.error && encyclopedia.ships.length === 0 ? (
            <div class="ships-view__status ships-view__status--error" key="error">
              <AlertTriangle size={24} />
              <p>{encyclopedia.error}</p>
              <SButton variant="secondary" size="sm" onClick={() => void loadEncyclopedia(true)}>
                <RotateCcw size={12} /> {t("ships.reload")}
              </SButton>
            </div>
          ) : viewMode.value === "tree" ? (
            <div class="ships-view__tree-body" key="tree">
              {/* nation rail — vertical list of faction crests */}
              <aside class="ships-view__nation-rail">
                {encyclopedia.nations.map((n) => (
                  <button
                    class={[
                      "ships-view__nation-btn",
                      treeNation.value === n ? "ships-view__nation-btn--on" : "",
                    ]}
                    title={nationLabel(n)}
                    onClick={() => (treeNation.value = n)}
                  >
                    <NationFlag nation={n} label={nationLabel(n)} variant="flag" size="sm" />
                    <span class="ships-view__nation-name">{nationLabel(n)}</span>
                  </button>
                ))}
              </aside>
              {/* the tree itself */}
              <div class="ships-view__tree-canvas">
                {treeNation.value ? (
                  <TechTreeView
                    nation={treeNation.value}
                    byId={shipsById.value}
                    onOpen={(ship: ShipInfo) => openDetail(ship)}
                  />
                ) : (
                  <div class="ships-view__status">{t("ships.empty")}</div>
                )}
              </div>
            </div>
          ) : filteredShips.value.length === 0 ? (
            <div class="ships-view__status" key="empty">{t("ships.empty")}</div>
          ) : (
            <div class="ships-view__grid" key="grid">
              {filteredShips.value.map((ship) => {
                const battles = shipBattles(ship.shipId);
                const wr = shipWr(ship.shipId);
                const rarity = shipRarity(ship); // RaritySignals fields present on ShipInfo
                return (
                  <div
                    class={[
                      "ship-card",
                      `ship-card--${ship.type.toLowerCase()}`,
                      `ship-card--${RARITY_CARD_MOD[rarity]}`,
                    ]}
                    onClick={() => openDetail(ship)}
                  >
                    {(() => {
                      const imgUrl = resolveShipImage(ship.shipId, ship.images?.medium);
                      return imgUrl ? (
                        <div class="ship-card__image">
                          <img src={imgUrl} alt={ship.name} loading="lazy" />
                        </div>
                      ) : null;
                    })()}
                    <div class="ship-card__head">
                      <span class="ship-card__tier">T{ship.tier}</span>
                      <span class="ship-card__name">{encyclopedia.shipDisplayName(ship)}</span>
                    </div>
                  <div class="ship-card__tags">
                    <STag variant="neutral" size="sm">{typeLabel(ship.type)} ({SHIP_TYPE_SHORT[ship.type] ?? "?"})</STag>
                    <NationFlag nation={ship.nation} label={nationLabel(ship.nation)} variant="flag" size="sm" />
                    <STag variant={RARITY_VARIANT[rarity]} size="sm">{t(`ships.rarity.${rarity}`)}</STag>
                  </div>
                  <div class="ship-card__stats">
                    {hp(ship) != null ? (
                      <div class="ship-card__stat">
                        <span class="ship-card__stat-label">{t("ships.card.hp")}</span>
                        <span class="ship-card__stat-value">{hp(ship)!.toLocaleString()}</span>
                      </div>
                    ) : null}
                    {concealment(ship) != null ? (
                      <div class="ship-card__stat">
                        <span class="ship-card__stat-label">{t("ships.card.concealment")}</span>
                        <span class="ship-card__stat-value">{concealment(ship)!.toFixed(1)}km</span>
                      </div>
                    ) : null}
                    {speed(ship) != null ? (
                      <div class="ship-card__stat">
                        <span class="ship-card__stat-label">{t("ships.card.speed")}</span>
                        <span class="ship-card__stat-value">{speed(ship)!.toFixed(0)}kn</span>
                      </div>
                    ) : null}
                  </div>
                  {battles != null ? (
                    <div class="ship-card__mine">
                      <span>
                        {t("ships.card.battles")}: <strong>{battles}</strong>
                      </span>
                      {wr != null ? (
                        <span class="ship-card__wr" style={{ color: winrateColor(wr) }}>
                          {wr.toFixed(1)}%
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            </div>
          )}
        </Transition>
        </div>

        {/* ── detail modal ── */}
        <ShipDetailModal
          ship={selectedShip.value}
          gameRoot={gameRoot.value}
          onClose={() => (selectedShip.value = null)}
        />
      </div>
    );
  },
});
