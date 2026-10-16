/**
 * LiveStatsModeChip — the stats-source tag: a pill that opens the
 * filter-style popup hosting THE VERY COLUMN EDITOR the settings page
 * renders (OverlayColumnsEditor — the draggable scope × metric cards +
 * the plus-connector's add menu), so the roster's per-column content is
 * editable right where it renders. The retired three-row dimension
 * filter groups (ship / battle / solo scopes) are gone: the ship/solo
 * scopes moved INTO the columns themselves; the battle-type career —
 * the one dimension that stays panel-wide — keeps its segmented row
 * under the editor, reading and writing the SAME statsPrefs store field
 * the settings page hosts.
 *
 * Mounted in two hosts: the live panel's head and the post-battle share
 * bar (PostBattleShareBar — riding the replay results modal and its
 * incomplete-results fallback), so both windows offer the identical
 * selector and every edit re-resolves the roster through the shared store.
 *
 * The popup frame follows the filter-bar popup pattern (FilterCategoryChip):
 * HkPopover teleported to body level and anchored bottom-start, outside
 * close via a document pointerdown listener while open (HkPopover's own
 * backdrop close stays off on desktop so re-clicking the open chip keeps
 * toggling it; Escape still closes), phones dock it as a bottom sheet.
 * Presses inside ANY hikari popover panel count as inside — the editor's
 * own add-connector opens a NESTED HkPopover that teleports to body
 * level, outside this anchor's subtree.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";

import { HkPopover, HkTabs, useBreakpoint } from "@celestia-island/hikari";
import { ShipWheel } from "@lucide/vue";

import { t } from "@/i18n";
import {
  overlayColumnsAreDefault,
  useStatsPrefsStore,
  type RosterBattleScope,
} from "@/stores/statsPrefs";
import OverlayColumnsEditor from "@/components/settings/OverlayColumnsEditor";
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
      // The editor's add-connector opens a NESTED HkPopover that
      // teleports to body level — outside this anchor's subtree, but a
      // press inside the columns editor all the same; any hikari popover
      // panel (the nested menu, its scrim) counts as inside.
      if (
        typeof Element !== "undefined" &&
        target instanceof Element &&
        target.closest(".hk-popover-panel, .hk-popover-scrim")
      ) {
        return;
      }
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

    /** Any dimension off its default — the columns edited off the
     *  shipped four, or the battle scope pinned — the chip then wears
     *  its active face, exactly like the head's other toggles. */
    const customized = computed(
      () =>
        !overlayColumnsAreDefault(prefs.prefs.overlayColumns) ||
        prefs.prefs.overlayBattleScope !== "follow",
    );

    /** The non-default dimensions joined with " · "; the resting face is
     *  the chip's own name ("战绩筛选") — never an option label, which
     *  would collide with the identically-named option inside the
     *  popup. */
    const label = computed(() => {
      const parts: string[] = [];
      if (!overlayColumnsAreDefault(prefs.prefs.overlayColumns)) {
        parts.push(t("settings.overlayContent.columnsLabel"));
      }
      if (prefs.prefs.overlayBattleScope !== "follow") {
        parts.push(t(BATTLE_SCOPE_LABEL[prefs.prefs.overlayBattleScope]));
      }
      return parts.length > 0
        ? parts.join(" · ")
        : t("replay.live.statsSourceTitle");
    });

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
            {/* The columns themselves — the identical editor the
                settings' 显示内容 section renders (one shared store:
                edits here show up there, and vice versa). */}
            <OverlayColumnsEditor />
            {/* The battle-type career feeding every column — the one
                panel-wide dimension left. */}
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
