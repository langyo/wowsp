import { computed, defineComponent, ref, watch } from "vue";
import { RotateCcw, Star } from "lucide-vue-next";

import SSelect from "@/components/base/SSelect";
import SButton from "@/components/base/SButton";
import STag from "@/components/base/STag";
import SSpinner from "@/components/base/SSpinner";
import { useAccountStore } from "@/stores/account";
import { useConfigStore } from "@/stores/config";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useShipStatsStore } from "@/stores/shipStats";
import { useTrendsStore } from "@/stores/trends";
import { api, type ShipInfo } from "@/api";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
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

    // ── realm picker + load ────────────────────────────────────────────
    const realm = ref(accounts.activeRealm || "asia");
    const realms = ["ru", "eu", "na", "asia"];

    async function loadEncyclopedia(force = false) {
      await encyclopedia.load(realm.value, force);
      // If an account is bound, also load their per-ship stats so cards can
      // show "your battles" badges.
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

    // ── filters ────────────────────────────────────────────────────────
    const searchText = ref("");
    const selectedNations = ref<Set<string>>(new Set());
    const selectedTypes = ref<Set<string>>(new Set());
    const tierMin = ref(1);
    const tierMax = ref(10);

    function toggleSet(set: Set<string>, value: string) {
      const next = new Set(set);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    }

    const filteredShips = computed(() => {
      const q = searchText.value.trim().toLowerCase();
      return encyclopedia.ships.filter((s) => {
        if (s.tier < tierMin.value || s.tier > tierMax.value) return false;
        if (selectedNations.value.size > 0 && !selectedNations.value.has(s.nation)) return false;
        if (selectedTypes.value.size > 0 && !selectedTypes.value.has(s.type)) return false;
        if (q && !s.name.toLowerCase().includes(q)) return false;
        return true;
      });
    });

    // ── detail modal ───────────────────────────────────────────────────
    const selectedShip = ref<ShipInfo | null>(null);
    const gameRoot = computed(() => config.activeInstall?.path ?? "");

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
        </header>

        {encyclopedia.version ? (
          <div class="ships-view__meta">
            <span>
              {t("ships.versionLabel")}: <strong>{encyclopedia.version.gameVersion}</strong>
            </span>
            <span>{t("ships.shipsCount", { n: filteredShips.value.length })}</span>
          </div>
        ) : null}

        {/* ── filter bar ── */}
        <div class="ships-view__filters">
          <input
            class="ships-view__search"
            type="text"
            placeholder={t("ships.search")}
            value={searchText.value}
            onInput={(e) => (searchText.value = (e.target as HTMLInputElement).value)}
          />

          <div class="ships-view__filter-group">
            <span class="ships-view__filter-label">{t("ships.type")}</span>
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
            <span class="ships-view__filter-label">{t("ships.nation")}</span>
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
            <span class="ships-view__filter-label">
              {t("ships.tierRange")}: {tierMin.value} – {tierMax.value}
            </span>
            <div class="ships-view__tier-range">
              <input
                type="range"
                min="1"
                max="10"
                value={tierMin.value}
                onInput={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  tierMin.value = Math.min(v, tierMax.value);
                }}
              />
              <input
                type="range"
                min="1"
                max="10"
                value={tierMax.value}
                onInput={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  tierMax.value = Math.max(v, tierMin.value);
                }}
              />
            </div>
          </div>
        </div>

        {/* ── card grid ── */}
        {encyclopedia.loading ? (
          <div class="ships-view__status">
            <SSpinner center size="lg" text={t("ships.loading")} />
          </div>
        ) : encyclopedia.error ? (
          <div class="ships-view__status ships-view__status--error">{encyclopedia.error}</div>
        ) : filteredShips.value.length === 0 ? (
          <div class="ships-view__status">{t("ships.empty")}</div>
        ) : (
          <div class="ships-view__grid">
            {filteredShips.value.map((ship) => {
              const battles = shipBattles(ship.shipId);
              const wr = shipWr(ship.shipId);
              return (
                <div
                  class={[
                    "ship-card",
                    `ship-card--${ship.type.toLowerCase()}`,
                    ship.isPremium ? "ship-card--premium" : "",
                    ship.isSpecial ? "ship-card--special" : "",
                  ]}
                  onClick={() => openDetail(ship)}
                >
                  <div class="ship-card__head">
                    <span class="ship-card__tier">T{ship.tier}</span>
                    <span class="ship-card__name">{ship.name}</span>
                  </div>
                  <div class="ship-card__tags">
                    <STag variant="neutral" size="sm">{typeLabel(ship.type)}</STag>
                    <STag variant="neutral" size="sm">{nationLabel(ship.nation)}</STag>
                    {ship.isPremium ? (
                      <STag variant="gold" size="sm"><Star size={10} fill="currentColor" /></STag>
                    ) : null}
                    {ship.isSpecial ? (
                      <STag variant="info" size="sm">{t("ships.special")}</STag>
                    ) : null}
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
