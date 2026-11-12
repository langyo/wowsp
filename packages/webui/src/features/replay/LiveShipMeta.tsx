/**
 * Ship-identity strip + hover combat card for the live-battle roster rows.
 *
 * Sits in the live roster's FULL card and the post-battle full card as the
 * right block's second element (under the aligned stat line; compact rows
 * drop it entirely), and shows, synchronously from the baked
 * `ship_live_stats.json`: the tier (roman), the class icon + short code, the
 * nation flag, the leading combat-relevant parameters (main/secondary/
 * torpedo range, ASW airstrike — capped so the strip holds one line), and —
 * ALLY ROWS ONLY — the ship's notable consumable slots, upgrade count and
 * signal-flag capacity as compact badges.
 *
 * Hovering the strip floats a condensed ship card on hikari's HkPopover
 * (issue #1736's hover-card family — the recipe the holo scorebar's
 * HoloShipTooltip shares): the popover owns the teleport, the measure-
 * then-place pass (below-preferred, flip above, clamped — the retired
 * placeLiveCard's contract), the root DPI zoom's local space, the z slot
 * and the pop motion. The host keeps only the hover choreography: the arm
 * delay, the strip↔card travel grace, and the scroll/Escape closes. The
 * card body carries the player's decoded loadout (the PlayerBuildGrid
 * section, ally rows only — the IPC surface never carries enemy builds)
 * followed by the ship's spec groups. A row whose build has not been
 * decoded yet (or a client version the build decoder does not cover) keeps
 * the spec-only card, exactly as before.
 *
 * Renders nothing when no database knows the ship: the baked offline DBs
 * first, then the runtime GameParams registrations — a runtime entry
 * restores the identity strip (tier / class icon / nation flag) but carries
 * no bake-grade live stats, so the parameter chips stay empty for it
 * (event ships outside both sources still render nothing at all).
 */
import { computed, defineComponent, onBeforeUnmount, ref } from "vue";
import { Flag, Wrench } from "@lucide/vue";
import { HkPopover, HkScrollContainer } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import BattleIcon from "@/components/base/BattleIcon";
import AppTag from "@/components/base/AppTag";
import NationFlag from "@/components/base/NationFlag";
import {
  nationNameFromDb,
  shipOfflineEntry,
} from "@/features/holographic/modelLoader";
import { runtimeShipEpoch } from "./runtimeShipIdentity";
import {
  formatShipParams,
  formatShipSpecGroups,
  isBadgeConsumable,
  shipConsumableLabel,
  shipLiveStats,
  shipTypeLabel,
  shipTypeShort,
  tierRoman,
} from "./shipLiveStats";
import PlayerBuildGrid from "./PlayerBuildGrid";
import { playerBuildHasContent, type PlayerBuildView } from "./playerBuild";
import "./LiveShipMeta.scss";

/** Card body width (the retired LIVE_CARD_WIDTH_PX): the spec table wraps
 *  at this column. */
const CARD_WIDTH_PX = 360;
/** Wider body when the card carries the player-build section (four grids
 *  need the extra room; the retired LIVE_CARD_BUILD_WIDTH_PX). */
const CARD_BUILD_WIDTH_PX = 460;
/** Hover-in delay before the card opens (the strip's arm rhythm). */
const OPEN_DELAY_MS = 220;
/** Leave grace so the pointer can travel between strip and card. */
const CLOSE_GRACE_MS = 180;

/** Consumable families worth a row badge, in slot order. */
function badgeFamilies(load: string[] | undefined): string[] {
  return (load ?? []).filter((f) => isBadgeConsumable(f));
}

/** Parameter chips kept on the inline row: the leading few of the canonical
 *  order only (main/secondary/torpedo/airstrike). The rest — AA band,
 *  concealment, speed — live one hover away in the flyout card, so the strip
 *  stays inside its fixed column instead of wrapping into the card's height. */
const INLINE_PARAM_LIMIT = 4;

export default defineComponent({
  name: "LiveShipMeta",
  props: {
    // VehicleEntry types shipId as a number, but string shipIds reach the
    // frontend through some paths (the mock backend serves raw JSON) —
    // accept both; the accessors stringify anyway.
    shipId: { type: [Number, String], required: true },
    /** Ally rows (relation ≤ 1) additionally carry the consumable/module/
     *  flag summary badges; enemy rows carry identity + parameters only. */
    ally: { type: Boolean, default: false },
    /** The player's decoded loadout view (playerBuild.ts), ally rows only.
     *  Null keeps the card spec-only and its original width. */
    build: { type: Object as () => PlayerBuildView | null, default: null },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();

    // shipOfflineEntry reads plain (non-reactive) module state, so the
    // runtime registrations that land after mount are invisible to the
    // computed unless the epoch bump is tracked as a dependency here.
    const entry = computed(() => {
      void runtimeShipEpoch.value;
      return shipOfflineEntry(props.shipId);
    });
    const stats = computed(() => shipLiveStats(props.shipId));
    const tier = computed(() => tierRoman(entry.value?.tier ?? null));
    // Cruisers read CA vs CL from the baked main-gun caliber (fallback CA).
    const typeShort = computed(() =>
      shipTypeShort(entry.value?.type ?? null, stats.value?.cal),
    );
    const typeLabel = computed(() => shipTypeLabel(entry.value?.type ?? null));
    const nation = computed(() => entry.value?.nation ?? null);
    const nationLabel = computed(() =>
      nation.value
        ? nationNameFromDb(nation.value, dataLanguage.value) ?? nation.value
        : "",
    );
    const chips = computed(() =>
      stats.value ? formatShipParams(stats.value, INLINE_PARAM_LIMIT) : [],
    );
    const badges = computed(() =>
      props.ally && stats.value ? badgeFamilies(stats.value.load) : [],
    );
    const upgrades = computed(() => stats.value?.upg ?? []);
    const flagCap = computed(() => stats.value?.flags ?? null);

    // ── Decoded player build (ally rows only) ─────────────────────────────
    // The grid renders only when the decode carried a loadout; an empty or
    // partial build keeps the card exactly as it was (spec-only).
    const showBuild = computed(() => playerBuildHasContent(props.build));
    /** Card body width — the four build grids need more room than the spec
     *  card (HkPopover's panel wraps the content box either way). */
    const cardWidth = computed(() =>
      showBuild.value ? CARD_BUILD_WIDTH_PX : CARD_WIDTH_PX,
    );

    // ── Flyout card (HkPopover owns the anchored placement) ───────────────
    const flyoutOpen = ref(false);
    // The strip element itself is the popover's anchor.
    const stripEl = ref<HTMLElement | null>(null);
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let inZone = false;
    let inCard = false;

    function armFlyout() {
      inZone = true;
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        // A row unmounting during the arm delay (roster reshuffle) takes
        // this component — and its popover — down with it: the unmount
        // cleanup clears the pending timer, so no detached-anchor guard
        // is needed here.
        flyoutOpen.value = true;
      }, OPEN_DELAY_MS);
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
      }, CLOSE_GRACE_MS);
    }
    function onCardEnter() {
      inCard = true;
    }
    function onCardLeave() {
      inCard = false;
      scheduleHide();
    }
    // Scrolling anywhere OUTSIDE the card (the panel body scrolls under a
    // stationary pointer) detaches the anchored card — close instead of
    // drifting. Scrolls inside the card are content browsing and must keep
    // it open, so capture-phase events originating in .live-ship-card (its
    // scroll viewport included, via closest) are ignored.
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
      // A decoded build alone is enough to render the hover target (a
      // runtime-registered hull can miss the offline identity strip); without
      // a build the original "nothing known" skip stands.
      if (!showBuild.value && (!entry.value || (!chips.value.length && !tier.value))) {
        return null;
      }

      const identity = (
        <span class="live-ship-meta__id">
          {tier.value ? (
            <AppTag tone="primary" pill={false} data-hint={`${t("replay.live.tier")} ${tier.value}`}>
              {tier.value}
            </AppTag>
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
        <AppTag class="live-ship-meta__chip" tone="default" pill={false} key={c.label}>
          <span class="live-ship-meta__chip-label">{c.label}</span>
          <span class="live-ship-meta__chip-value">{c.value}</span>
        </AppTag>
      ));

      const badgeEls = [
        ...badges.value.map((f) => (
          <AppTag tone="success" face="outline" key={f}>
            {shipConsumableLabel(f)}
          </AppTag>
        )),
        upgrades.value.length ? (
          <AppTag tone="default" face="outline" key="__upg">
            <Wrench size={10} />
            {"×"}
            {upgrades.value.length}
          </AppTag>
        ) : null,
        flagCap.value ? (
          <AppTag tone="warning" face="outline" key="__flag">
            <Flag size={10} />
            {"×"}
            {flagCap.value}
          </AppTag>
        ) : null,
      ];

      return (
        <span
          class="live-ship-meta"
          ref={stripEl}
          onMouseenter={armFlyout}
          onMouseleave={disarmZone}
        >
          {/* One clipping line: identity + the leading parameter chips. The
              badges ride a second line below (ally rows only). */}
          <span class="live-ship-meta__row">
            {!entry.value && showBuild.value ? (
              <AppTag tone="primary" face="outline">
                {t("replay.live.build.title")}
              </AppTag>
            ) : null}
            {identity}
            {chipEls.length ? (
              <span class="live-ship-meta__chips">{chipEls}</span>
            ) : null}
          </span>
          {badgeEls.length ? (
            <span class="live-ship-meta__badges">{badgeEls}</span>
          ) : null}
          {/* Combat-card scroller: the popover panel carries the card skin;
              the hikari scroll container fills it (the overlay track rides
              the card's right edge) and the inner wrapper pins the card's
              width so the spec table wraps at its column. */}
          <HkPopover
            class="live-ship-card"
            modelValue={flyoutOpen.value}
            onUpdate:modelValue={(v: boolean) => {
              if (!v) flyoutOpen.value = false;
            }}
            anchorRef={stripEl.value}
            placement="bottom-start"
            offset={8}
            backdrop={false}
            closeOnBackdrop={false}
            closeOnEscape={false}
            glass={false}
            onMouseenter={onCardEnter}
            onMouseleave={onCardLeave}
          >
            <HkScrollContainer class="live-ship-card__scroll">
              <div class="live-ship-card__inner" style={{ width: `${cardWidth.value}px` }}>
                <div class="live-ship-card__head">
                  {tier.value ? <AppTag tone="primary" pill={false}>{tier.value}</AppTag> : null}
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
                </div>

                {showBuild.value && props.build ? <PlayerBuildGrid view={props.build} /> : null}

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
              </div>
            </HkScrollContainer>
          </HkPopover>
        </span>
      );
    };
  },
});
