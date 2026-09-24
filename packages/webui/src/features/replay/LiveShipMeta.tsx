/**
 * Ship-identity strip + hover combat card for the live-battle roster rows.
 *
 * Sits in the middle of every player card (between the name/ship/stat stack
 * and the career seal) and shows, synchronously from the baked
 * `ship_live_stats.json`: the tier (roman), the class icon + short code, the
 * nation flag, the combat-relevant parameters (main/secondary/torpedo range,
 * ASW airstrike, outer AA band, concealment, speed), and — ALLY ROWS ONLY —
 * the ship's notable consumable slots, researchable-module kinds, signal-flag
 * capacity and legendary commanders. Enemy rows carry identity + parameters
 * only: loadout data does not exist in the battle data (neither GameParams
 * nor the WG API exposes per-player fits), and inventing "intelligence" about
 * enemy builds would be fabrication.
 *
 * Hovering the strip floats a condensed ship card (teleported to <body>,
 * fixed position): the full spec groups plus the loadout section on ally
 * rows. Everything here is ship CAPABILITY, never a player's actual fit —
 * the card footer says so.
 *
 * Renders nothing when the ship is missing from the offline DBs (event ships
 * outside both sources).
 */
import { computed, defineComponent, onBeforeUnmount, ref, Teleport, type CSSProperties } from "vue";
import { Flag, Wrench } from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import BattleIcon from "@/components/base/BattleIcon";
import NationFlag from "@/components/base/NationFlag";
import {
  nationNameFromDb,
  shipOfflineEntry,
} from "@/features/holographic/modelLoader";
import commandersData from "@/data/commanders.json";
import { gameNationOf } from "@/utils/nationCodes";
import {
  formatShipParams,
  formatShipSpecGroups,
  isBadgeConsumable,
  shipConsumableLabel,
  shipLiveStats,
  shipTypeLabel,
  shipTypeShort,
  shipUpgradeLabel,
  tierRoman,
} from "./shipLiveStats";
import "./LiveShipMeta.scss";

interface CommanderEntry {
  name: string;
  person: string;
  nations: string[];
  talents: unknown[];
}

const COMMANDERS = commandersData as CommanderEntry[];

/** Consumable families worth a row badge, in slot order. */
function badgeFamilies(load: string[] | undefined): string[] {
  return (load ?? []).filter((f) => isBadgeConsumable(f));
}

export default defineComponent({
  name: "LiveShipMeta",
  props: {
    // VehicleEntry types shipId as a number, but string shipIds reach the
    // frontend through some paths (the mock backend serves raw JSON) —
    // accept both; the accessors stringify anyway.
    shipId: { type: [Number, String], required: true },
    /** Ally rows (relation ≤ 1) may carry the loadout summary; enemy rows
     *  never do — the note in the flyout explains the policy either way. */
    ally: { type: Boolean, default: false },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();

    const entry = computed(() => shipOfflineEntry(props.shipId));
    const stats = computed(() => shipLiveStats(props.shipId));
    const tier = computed(() => tierRoman(entry.value?.tier ?? null));
    const typeShort = computed(() => shipTypeShort(entry.value?.type ?? null));
    const typeLabel = computed(() => shipTypeLabel(entry.value?.type ?? null));
    const nation = computed(() => entry.value?.nation ?? null);
    const nationLabel = computed(() =>
      nation.value
        ? nationNameFromDb(nation.value, dataLanguage.value) ?? nation.value
        : "",
    );
    const chips = computed(() => (stats.value ? formatShipParams(stats.value) : []));
    const badges = computed(() =>
      props.ally && stats.value ? badgeFamilies(stats.value.load) : [],
    );
    const upgrades = computed(() => stats.value?.upg ?? []);
    const flagCap = computed(() => stats.value?.flags ?? null);
    /** Legendary (talent-carrying) commanders usable on this ship's nation —
     *  the "special captain" surface the battle data can legitimately offer. */
    const legendary = computed(() => {
      if (!nation.value) return [];
      const gp = gameNationOf(nation.value);
      return COMMANDERS.filter((c) => c.talents.length > 0 && c.nations.includes(gp)).map(
        (c) => {
          const key = `ships.skills.commanders.${c.person}`;
          const msg = t(key);
          return msg === key ? c.person.replace(/_/g, " ") : msg;
        },
      );
    });

    // ── Flyout card ────────────────────────────────────────────────────────
    const flyoutOpen = ref(false);
    const flyoutPos = ref<CSSProperties>({});
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let inZone = false;
    let inCard = false;

    function armFlyout(el: HTMLElement) {
      inZone = true;
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        // The row can unmount during the arm delay (roster reshuffle) — a
        // zero rect would clamp the card into a corner; skip and let the
        // next hover re-arm instead.
        if (!r.width && !r.height) return;
        const width = 360;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        // Below the strip; flip above when an estimated card height would
        // overflow the bottom (the card itself scrolls if still too tall).
        const estHeight = 420;
        const below = r.bottom + 8;
        const top =
          below + estHeight < window.innerHeight
            ? below
            : Math.max(8, r.top - 8 - estHeight);
        flyoutPos.value = { left: `${left}px`, top: `${top}px`, width: `${width}px` };
        flyoutOpen.value = true;
      }, 220);
    }
    function disarmZone() {
      inZone = false;
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      scheduleHide();
    }
    function scheduleHide() {
      // Leave a beat so the pointer can travel between strip and card.
      setTimeout(() => {
        if (!inZone && !inCard) flyoutOpen.value = false;
      }, 180);
    }
    function onCardEnter() {
      inCard = true;
    }
    function onCardLeave() {
      inCard = false;
      scheduleHide();
    }
    // Scrolling anywhere OUTSIDE the card (the panel body scrolls under a
    // stationary pointer) detaches a fixed-position card — close instead of
    // drifting. Scrolls inside the card are content browsing and must keep
    // it open, so capture-phase events originating in .live-ship-card are
    // ignored.
    function onScrollCapture(e: Event) {
      const target = e.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest(".live-ship-card")) {
        return;
      }
      flyoutOpen.value = false;
    }
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") flyoutOpen.value = false;
    }
    document.addEventListener("scroll", onScrollCapture, true);
    document.addEventListener("keydown", onKeydown);
    onBeforeUnmount(() => {
      document.removeEventListener("scroll", onScrollCapture, true);
      document.removeEventListener("keydown", onKeydown);
      if (showTimer) clearTimeout(showTimer);
    });

    const specGroups = computed(() =>
      stats.value ? formatShipSpecGroups(stats.value) : [],
    );

    return () => {
      if (!entry.value || (!chips.value.length && !tier.value)) return null;
      const s = stats.value;

      const identity = (
        <span class="live-ship-meta__id">
          {tier.value ? (
            <span class="live-ship-meta__tier" data-hint={`${t("replay.live.tier")} ${tier.value}`}>
              {tier.value}
            </span>
          ) : null}
          <BattleIcon type={entry.value?.type ?? ""} variant="plain" size={13} />
          {typeShort.value ? <span class="live-ship-meta__type">{typeShort.value}</span> : null}
          {nation.value ? (
            <NationFlag
              nation={nation.value}
              label={nationLabel.value}
              variant="flag"
              size="sm"
            />
          ) : null}
        </span>
      );

      const chipEls = chips.value.map((c) => (
        <span class="live-ship-meta__chip" key={c.label}>
          <span class="live-ship-meta__chip-label">{c.label}</span>
          <span class="live-ship-meta__chip-value">{c.value}</span>
        </span>
      ));

      const badgeEls = [
        ...badges.value.map((f) => (
          <span class="live-ship-meta__badge" key={f}>
            {shipConsumableLabel(f)}
          </span>
        )),
        upgrades.value.length ? (
          <span
            class="live-ship-meta__badge live-ship-meta__badge--upg"
            key="__upg"
          >
            <Wrench size={10} />
            {"×"}
            {upgrades.value.length}
          </span>
        ) : null,
        flagCap.value ? (
          <span class="live-ship-meta__badge live-ship-meta__badge--flag" key="__flag">
            <Flag size={10} />
            {"×"}
            {flagCap.value}
          </span>
        ) : null,
      ];

      const loadoutNames = (s?.load ?? []).map((f) => shipConsumableLabel(f));

      const flyout = flyoutOpen.value ? (
        <Teleport to="body">
          <div
            class="live-ship-card"
            style={flyoutPos.value}
            onMouseenter={onCardEnter}
            onMouseleave={onCardLeave}
          >
            <div class="live-ship-card__head">
              {tier.value ? (
                <span class="live-ship-card__tier">{tier.value}</span>
              ) : null}
              <BattleIcon type={entry.value?.type ?? ""} variant="plain" size={16} />
              {typeLabel.value ? (
                <span class="live-ship-card__type">{typeLabel.value}</span>
              ) : null}
              {nation.value ? (
                <NationFlag
                  nation={nation.value}
                  label={nationLabel.value}
                  variant="flag"
                  size="sm"
                />
              ) : null}
              {props.ally ? null : (
                <span class="live-ship-card__enemy-note">{t("replay.live.card.enemyNote")}</span>
              )}
            </div>

            {specGroups.value.length ? (
              <div class="live-ship-card__groups">
                {specGroups.value.map(([group, rows]) => (
                  <div class="live-ship-card__group" key={group}>
                    <div class="live-ship-card__group-title">{group}</div>
                    <div class="live-ship-card__rows">
                      {rows.map(([label, value]) => (
                        <div class="live-ship-card__row" key={label}>
                          <span class="live-ship-card__row-label">{label}</span>
                          <span class="live-ship-card__row-value">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p class="live-ship-card__empty">{t("replay.live.card.noData")}</p>
            )}

            {props.ally ? (
              <div class="live-ship-card__loadout">
                <div class="live-ship-card__group-title">{t("replay.live.card.loadout")}</div>
                {loadoutNames.length ? (
                  <p class="live-ship-card__line">
                    <span class="live-ship-card__line-label">
                      {t("replay.live.card.consumables")}
                    </span>
                    {loadoutNames.join(" / ")}
                  </p>
                ) : null}
                {upgrades.value.length ? (
                  <p class="live-ship-card__line">
                    <span class="live-ship-card__line-label">
                      {t("replay.live.card.upgrades")}
                    </span>
                    {upgrades.value.map((code) => shipUpgradeLabel(code)).join(" / ")}
                  </p>
                ) : (
                  <p class="live-ship-card__line">
                    <span class="live-ship-card__line-label">
                      {t("replay.live.card.upgrades")}
                    </span>
                    {t("replay.live.card.upgradesNone")}
                  </p>
                )}
                {flagCap.value ? (
                  <p class="live-ship-card__line">
                    <span class="live-ship-card__line-label">
                      {t("replay.live.card.flags")}
                    </span>
                    {"×"}
                    {flagCap.value}
                  </p>
                ) : null}
                {legendary.value.length ? (
                  <p class="live-ship-card__line">
                    <span class="live-ship-card__line-label">
                      {t("replay.live.card.commander")}
                    </span>
                    {legendary.value.join(" / ")}
                  </p>
                ) : null}
                <p class="live-ship-card__note">{t("replay.live.card.loadoutNote")}</p>
              </div>
            ) : null}
          </div>
        </Teleport>
      ) : null;

      return (
        <span
          class="live-ship-meta"
          onMouseenter={(e: MouseEvent) => armFlyout(e.currentTarget as HTMLElement)}
          onMouseleave={disarmZone}
        >
          {identity}
          {chipEls.length ? (
            <span class="live-ship-meta__chips">{chipEls}</span>
          ) : null}
          {badgeEls.length ? (
            <span class="live-ship-meta__badges">{badgeEls}</span>
          ) : null}
          {flyout}
        </span>
      );
    };
  },
});
