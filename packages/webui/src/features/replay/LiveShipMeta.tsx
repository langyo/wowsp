/**
 * Ship-identity strip + hover combat card for the live-battle roster rows.
 *
 * Sits in the middle of the live roster's FULL density row (between the
 * identity stack — nick/clan + ship name — and the shared aligned stat
 * columns; compact rows drop it entirely) and in the post-battle full card's
 * middle ground (whose name stack keeps its own stat line), and shows,
 * synchronously from the baked
 * `ship_live_stats.json`: the tier (roman), the class icon + short code, the
 * nation flag, the leading combat-relevant parameters (main/secondary/
 * torpedo range, ASW airstrike — capped so the strip holds one line), and —
 * ALLY ROWS ONLY — the ship's notable consumable slots, upgrade count and
 * signal-flag capacity as compact badges.
 *
 * Hovering the strip floats a condensed ship card (teleported to <body>,
 * fixed position): the player's decoded loadout (the PlayerBuildGrid section,
 * ally rows only — the IPC surface never carries enemy builds) followed by
 * the ship's spec groups. A row whose build has not been decoded yet (or a
 * client version the build decoder does not cover) keeps the spec-only card,
 * exactly as before.
 *
 * Renders nothing when no database knows the ship: the baked offline DBs
 * first, then the runtime GameParams registrations — a runtime entry
 * restores the identity strip (tier / class icon / nation flag) but carries
 * no bake-grade live stats, so the parameter chips stay empty for it
 * (event ships outside both sources still render nothing at all).
 */
import { computed, defineComponent, nextTick, onBeforeUnmount, ref, Teleport, type CSSProperties } from "vue";
import { Flag, Wrench } from "@lucide/vue";
import { HkScrollContainer } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import BattleIcon from "@/components/base/BattleIcon";
import NationFlag from "@/components/base/NationFlag";
import {
  nationNameFromDb,
  shipOfflineEntry,
} from "@/features/holographic/modelLoader";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
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
import {
  LIVE_CARD_BUILD_WIDTH_PX,
  LIVE_CARD_WIDTH_PX,
  placeLiveCard,
} from "./liveCardPlacement";
import PlayerBuildGrid from "./PlayerBuildGrid";
import { playerBuildHasContent, type PlayerBuildView } from "./playerBuild";
import "./LiveShipMeta.scss";

/** Consumable families worth a row badge, in slot order. */
function badgeFamilies(load: string[] | undefined): string[] {
  return (load ?? []).filter((f) => isBadgeConsumable(f));
}

/** Consumed slice of HkScrollContainer's exposed component ref (the ref
 *  yields the exposed handle, not an element — see the flyout card below). */
interface ScrollHandle {
  getScrollElement(): HTMLElement | undefined;
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
     *  card (the measure-then-place pass re-wraps either way). */
    const cardWidth = computed(() =>
      showBuild.value ? LIVE_CARD_BUILD_WIDTH_PX : LIVE_CARD_WIDTH_PX,
    );

    // ── Flyout card ────────────────────────────────────────────────────────
    const flyoutOpen = ref(false);
    const flyoutPos = ref<CSSProperties>({});
    // The card teleports to <body> — inside the root DPI zoom's subtree —
    // so its written left/top paint in the zoomed local space while the
    // anchor's gBCR and window.innerWidth/innerHeight answer in
    // root-visual px: placeLiveCard runs entirely in local space, fed the
    // measured values divided by the applied scale (the hint family's
    // zoom notes; offsetWidth/offsetHeight are already local).
    const dpiScale = useAppliedDpiScale();
    // The card is an HkScrollContainer: a COMPONENT ref — it exposes the
    // scrolling viewport (the measure-then-place pass below reads its box;
    // the card's 1px border sits just outside it), not an element.
    const card = ref<ScrollHandle | null>(null);
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
        // Render first (hidden), MEASURE the real box, then place: the
        // card's height is content-driven (a capped max-height spec table),
        // and an estimate flips sparse cards into thin air far above the
        // anchor. The width rides along so height wraps at its final layout.
        // An already-open card (pointer travelled card → strip) keeps its
        // layout: measure in place instead of blinking through the hidden
        // pass again.
        if (!flyoutOpen.value) {
          flyoutPos.value = {
            left: "0px",
            top: "0px",
            width: cardWidth.value + "px",
            visibility: "hidden",
          };
          flyoutOpen.value = true;
        }
        void nextTick(() => {
          const viewport = card.value?.getScrollElement();
          if (!viewport) return;
          // The strip rect is visual px; placeLiveCard's contract is the
          // card's zoomed local space — divide the visual inputs (the
          // offsetWidth/offsetHeight box is already local).
          const z = dpiScale.value;
          const { left, top } = placeLiveCard(
            {
              left: r.left / z,
              top: r.top / z,
              right: r.right / z,
              bottom: r.bottom / z,
            },
            viewport.offsetWidth,
            viewport.offsetHeight,
            window.innerWidth / z,
            window.innerHeight / z,
          );
          flyoutPos.value = {
            left: `${Math.round(left)}px`,
            top: `${Math.round(top)}px`,
            width: cardWidth.value + "px",
            visibility: "visible",
          };
        });
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

      const flyout = flyoutOpen.value ? (
        <Teleport to="body">
          {/* Combat-card scroller: the card element itself is the hikari
              container — its own fixed positioning (plus the inline
              left/top below) wins over the container root's relative, and
              the overlay track rides the card's right edge. */}
          <HkScrollContainer
            ref={card}
            class="live-ship-card"
            style={flyoutPos.value}
            // The hover keep-alive spreads in (the component's props declare
            // no DOM events; Vue's attr fallthrough still lands both on the
            // root, covering the overlay track as well).
            {...{ onMouseenter: onCardEnter, onMouseleave: onCardLeave }}
          >
            <div class="live-ship-card__inner">
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
        </Teleport>
      ) : null;

      return (
        <span
          class="live-ship-meta"
          onMouseenter={(e: MouseEvent) => armFlyout(e.currentTarget as HTMLElement)}
          onMouseleave={disarmZone}
        >
          {/* One clipping line: identity + the leading parameter chips. The
              badges ride a second line below (ally rows only). */}
          <span class="live-ship-meta__row">
            {!entry.value && showBuild.value ? (
              <span class="live-ship-meta__badge live-ship-meta__badge--build">
                {t("replay.live.build.title")}
              </span>
            ) : null}
            {identity}
            {chipEls.length ? (
              <span class="live-ship-meta__chips">{chipEls}</span>
            ) : null}
          </span>
          {badgeEls.length ? (
            <span class="live-ship-meta__badges">{badgeEls}</span>
          ) : null}
          {flyout}
        </span>
      );
    };
  },
});
