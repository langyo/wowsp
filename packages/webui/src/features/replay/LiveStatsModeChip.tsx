/**
 * LiveStatsModeChip — the stats-source tag: a pill that shows the CURRENT
 * three-dimension selection (ship scope / battle scope / solo filter) and
 * opens a filter-style popup hosting the very segmented groups the settings
 * page renders (OverlayContentControls) — identical option sets, reading
 * and writing the SAME statsPrefs store fields, so a flip here shows up in
 * the settings and vice versa, immediately.
 *
 * Mounted in two hosts: the live panel's head and the post-battle share
 * bar (PostBattleShareBar — riding the replay results modal and its
 * incomplete-results fallback), so both windows offer the identical
 * selector and every flip re-resolves the roster through the shared store.
 *
 * The popup frame follows the filter-bar popup pattern (FilterCategoryChip):
 * HkPopover teleported to body level and anchored bottom-start, outside
 * close via a document pointerdown listener while open (HkPopover's own
 * backdrop close stays off on desktop so re-clicking the open chip keeps
 * toggling it; Escape still closes), phones dock it as a bottom sheet.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";

import { HkPopover, HkTabs, useBreakpoint } from "@celestia-island/hikari";
import { ShipWheel } from "@lucide/vue";

import { t } from "@/i18n";
import {
  useStatsPrefsStore,
  type RosterBattleScope,
  type RosterShipScope,
  type RosterSoloScope,
} from "@/stores/statsPrefs";
import "./LiveStatsModeChip.scss";

/** scope value → its option label key (the settings rows use the same). */
const SHIP_SCOPE_LABEL: Record<RosterShipScope, string> = {
  all: "settings.overlayContent.shipScopeAll",
  class: "settings.overlayContent.shipScopeClass",
  tier: "settings.overlayContent.shipScopeTier",
  ship: "settings.overlayContent.shipScopeShip",
};
const BATTLE_SCOPE_LABEL: Record<RosterBattleScope, string> = {
  follow: "settings.overlayContent.battleFollow",
  random: "settings.overlayContent.battleRandom",
  ranked: "settings.overlayContent.battleRanked",
  all: "settings.overlayContent.battleAll",
};
const SOLO_SCOPE_LABEL: Record<RosterSoloScope, string> = {
  all: "settings.overlayContent.soloAll",
  solo: "settings.overlayContent.soloOnly",
};

export default defineComponent({
  name: "LiveStatsModeChip",
  setup() {
    const prefs = useStatsPrefsStore();
    const { isMobile } = useBreakpoint();
    const open = ref(false);
    // Outside-close test roots — the chip anchor and the teleported panel
    // (presses inside either must not count as outside, same contract as
    // FilterCategoryChip).
    const root = ref<HTMLElement | null>(null);
    const chipBtn = ref<HTMLButtonElement | null>(null);
    const panelEl = ref<HTMLElement | null>(null);

    function close() {
      open.value = false;
    }

    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (root.value?.contains(target)) return;
      if (panelEl.value?.contains(target)) return;
      close();
    }

    watch(
      open,
      (v) => {
        if (v) document.addEventListener("pointerdown", onDocPointerDown, true);
        else document.removeEventListener("pointerdown", onDocPointerDown, true);
      },
    );
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
    });

    /** Any dimension off its default — the chip then wears its active
     *  face, exactly like the head's other toggles. */
    const customized = computed(
      () =>
        prefs.prefs.overlayShipScope !== "all" ||
        prefs.prefs.overlayBattleScope !== "follow" ||
        prefs.prefs.overlaySoloScope !== "all",
    );

    /** The non-default dimensions joined with " · "; the default face is
     *  the battle scope's own label ("跟随对局") so the chip always says
     *  what the numbers currently read. */
    const label = computed(() => {
      const parts: string[] = [];
      if (prefs.prefs.overlayShipScope !== "all") {
        parts.push(t(SHIP_SCOPE_LABEL[prefs.prefs.overlayShipScope]));
      }
      if (prefs.prefs.overlayBattleScope !== "follow") {
        parts.push(t(BATTLE_SCOPE_LABEL[prefs.prefs.overlayBattleScope]));
      }
      if (prefs.prefs.overlaySoloScope === "solo") {
        parts.push(t(SOLO_SCOPE_LABEL.solo));
      }
      return parts.length > 0
        ? parts.join(" · ")
        : t(BATTLE_SCOPE_LABEL.follow);
    });

    /** One labeled segmented group row — the same HkTabs control (and
     *  option order) the settings page's stats-source rows render. */
    const group = <T extends string>(
      labelKey: string,
      value: T,
      set: (v: T) => void,
      tabs: { key: T; label: string }[],
    ) => (
      <div class="live-battle__mode-group">
        <span class="live-battle__mode-group-label">{t(labelKey)}</span>
        <HkTabs
          variant="segmented"
          modelValue={value}
          onUpdate:modelValue={(v: string) => set(v as T)}
          tabs={tabs}
        />
      </div>
    );

    return () => (
      <div ref={root} class="live-battle__mode-anchor">
        <button
          ref={chipBtn}
          type="button"
          class={[
            "live-battle__mode-btn",
            { "live-battle__mode-btn--on": customized.value },
          ]}
          aria-label={t("replay.live.statsSourceTitle")}
          onClick={() => (open.value = !open.value)}
        >
          <ShipWheel size={13} />
          {label.value}
        </button>
        <HkPopover
          modelValue={open.value}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) close();
          }}
          anchorRef={chipBtn.value}
          placement="bottom-start"
          closeOnBackdrop={isMobile.value}
          sheetOnMobile
          title={t("replay.live.statsSourceTitle")}
        >
          <div ref={panelEl} class="live-battle__mode-pop">
            {group(
              "settings.overlayContent.shipScope",
              prefs.prefs.overlayShipScope,
              (v) => prefs.setOverlayShipScope(v),
              [
                { key: "all" as RosterShipScope, label: t(SHIP_SCOPE_LABEL.all) },
                { key: "class" as RosterShipScope, label: t(SHIP_SCOPE_LABEL.class) },
                { key: "tier" as RosterShipScope, label: t(SHIP_SCOPE_LABEL.tier) },
                { key: "ship" as RosterShipScope, label: t(SHIP_SCOPE_LABEL.ship) },
              ],
            )}
            {group(
              "settings.overlayContent.battleScope",
              prefs.prefs.overlayBattleScope,
              (v) => prefs.setOverlayBattleScope(v),
              [
                { key: "follow" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.follow) },
                { key: "random" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.random) },
                { key: "ranked" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.ranked) },
                { key: "all" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.all) },
              ],
            )}
            {group(
              "settings.overlayContent.soloScope",
              prefs.prefs.overlaySoloScope,
              (v) => prefs.setOverlaySoloScope(v),
              [
                { key: "all" as RosterSoloScope, label: t(SOLO_SCOPE_LABEL.all) },
                { key: "solo" as RosterSoloScope, label: t(SOLO_SCOPE_LABEL.solo) },
              ],
            )}
            <div class="live-battle__mode-pop-hint">
              {t("replay.live.statsSourceHint")}
            </div>
          </div>
        </HkPopover>
      </div>
    );
  },
});
