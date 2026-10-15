/**
 * LiveStatsModeChip — the stats-source tag: a pill that shows the current
 * battle-scope selection and opens a filter-style popup hosting the very
 * segmented group the settings page renders (OverlayContentControls) —
 * identical option set, reading and writing the SAME statsPrefs store
 * field, so a flip here shows up in the settings and vice versa,
 * immediately.
 *
 * The ship/solo scopes this chip used to carry moved INTO the roster
 * columns themselves (settings' column editor — each column is a scope ×
 * metric pair now); the battle-type career is the one dimension that
 * stays panel-wide, and it is the one this chip flips.
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
import { useStatsPrefsStore, type RosterBattleScope } from "@/stores/statsPrefs";
import "./LiveStatsModeChip.scss";

/** scope value → its option label key (the settings row uses the same). */
const BATTLE_SCOPE_LABEL: Record<RosterBattleScope, string> = {
  follow: "settings.overlayContent.battleFollow",
  random: "settings.overlayContent.battleRandom",
  ranked: "settings.overlayContent.battleRanked",
  all: "settings.overlayContent.battleAll",
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

    /** The battle scope off its default — the chip then wears its active
     *  face, exactly like the head's other toggles. */
    const customized = computed(
      () => prefs.prefs.overlayBattleScope !== "follow",
    );

    /** The non-default battle scope; the resting face is the chip's own
     *  name ("战绩筛选") — never the option label, which would collide
     *  with the identically-named option inside the popup. */
    const label = computed(() =>
      prefs.prefs.overlayBattleScope !== "follow"
        ? t(BATTLE_SCOPE_LABEL[prefs.prefs.overlayBattleScope])
        : t("replay.live.statsSourceTitle"),
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
            <div class="live-battle__mode-group">
              <span class="live-battle__mode-group-label">
                {t("settings.overlayContent.battleScope")}
              </span>
              <HkTabs
                variant="segmented"
                modelValue={prefs.prefs.overlayBattleScope}
                onUpdate:modelValue={(v: string) =>
                  prefs.setOverlayBattleScope(v as RosterBattleScope)
                }
                tabs={[
                  { key: "follow" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.follow) },
                  { key: "random" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.random) },
                  { key: "ranked" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.ranked) },
                  { key: "all" as RosterBattleScope, label: t(BATTLE_SCOPE_LABEL.all) },
                ]}
              />
            </div>
          </div>
        </HkPopover>
      </div>
    );
  },
});
