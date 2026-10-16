/**
 * LiveStatsModeChip — the stats-source tag: a pill that opens the
 * filter-style popup hosting THE VERY COLUMN EDITOR the settings page
 * renders (OverlayColumnsEditor — the draggable scope × metric cards +
 * the plus-connector's add menu), so the roster's per-column content is
 * editable right where it renders. The retired dimension filter rows
 * (ship / battle / solo scopes) are gone from this popup — the ship/solo
 * scopes live IN the columns themselves, and the panel-wide battle-type
 * scope keeps its settings row (OverlayContentControls) only; the chip's
 * active face and label key purely on the columns it edits.
 *
 * Mounted in two hosts: the live panel's head and the post-battle share
 * bar (PostBattleShareBar — riding the replay results modal and its
 * incomplete-results fallback), so both windows offer the identical
 * editor and every edit re-resolves the roster through the shared store.
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

import { HkPopover, useBreakpoint } from "@celestia-island/hikari";
import { ShipWheel } from "@lucide/vue";

import { t } from "@/i18n";
import { overlayColumnsAreDefault, useStatsPrefsStore } from "@/stores/statsPrefs";
import OverlayColumnsEditor from "@/components/settings/OverlayColumnsEditor";
import "./LiveStatsModeChip.scss";

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

    /** The columns off the shipped defaults — the chip then wears its
     *  active face, exactly like the head's other toggles. */
    const customized = computed(() =>
      !overlayColumnsAreDefault(prefs.prefs.overlayColumns),
    );

    /** The resting face is the chip's own name ("战绩筛选"); customized
     *  it names what it edits ("显示列"). */
    const label = computed(() =>
      customized.value
        ? t("settings.overlayContent.columnsLabel")
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
            {/* The columns themselves — the identical editor the
                settings' 显示内容 section renders (one shared store:
                edits here show up there, and vice versa). */}
            <OverlayColumnsEditor />
          </div>
        </HkPopover>
      </div>
    );
  },
});
