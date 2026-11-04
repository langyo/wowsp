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
 * `aiSort` (the results modal's share bar alone) appends a SECOND block
 * under the editor: the AI confidence switch — one knob owning the AI
 * score column's visibility AND the coverage-weighted roster sort (see
 * postBattleAiScore.ts), so the visible column and the order it implies
 * can never disagree. The live head keeps the plain editor (the AI score
 * column is a post-battle concept).
 *
 * The popup frame follows the filter-bar popup pattern (FilterCategoryChip):
 * HkPopover teleported to body level and anchored bottom-start, outside
 * close left to HkPopover's own backdrop shield — a document-level
 * click-capture that exempts the anchor subtree (re-clicking the open chip
 * still toggles it shut via its own onClick) and any popout layer stacked
 * above: presses inside the editor's NESTED add-connector HkPopover
 * (teleported to body level, outside this anchor's subtree) count as
 * inside. Escape still closes; phones dock the popup as a bottom sheet.
 */
import { computed, defineComponent, ref } from "vue";

import { HkPopover, HkSwitch } from "@celestia-island/hikari";
import { ShipWheel } from "@lucide/vue";

import { t } from "@/i18n";
import { overlayColumnsAreDefault, useStatsPrefsStore } from "@/stores/statsPrefs";
import OverlayColumnsEditor from "@/components/settings/OverlayColumnsEditor";
import "./LiveStatsModeChip.scss";

export default defineComponent({
  name: "LiveStatsModeChip",
  props: {
    /** Append the post-battle AI-sort switch as a second block under the
     *  column editor — the results modal's share bar alone passes this
     *  (the live panel's head chip keeps the plain column editor; the AI
     *  score column is a post-battle concept and has no live face). One
     *  switch owns BOTH the column's visibility and the weighted sort, so
     *  the roster and the order it implies can never disagree. */
    aiSort: { type: Boolean, default: false },
  },
  setup(props) {
    const prefs = useStatsPrefsStore();
    const open = ref(false);
    const chipBtn = ref<HTMLButtonElement | null>(null);

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
      <div class="live-battle__mode-anchor">
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
          onUpdate:modelValue={(v: boolean) => (open.value = v)}
          anchorRef={chipBtn.value}
          placement="bottom-start"
          sheetOnMobile
          padding="lg"
          title={t("replay.live.statsSourceTitle")}
        >
          <div class="live-battle__mode-pop">
            {/* The columns themselves — the identical editor the
                settings' 显示内容 section renders (one shared store:
                edits here show up there, and vice versa). */}
            <OverlayColumnsEditor />
            {/* Second block (post-battle hosts only): the AI confidence
                switch — shows the AI score column AND flips the roster
                sort to the coverage-weighted key. */}
            {props.aiSort ? (
              <div class="live-battle__mode-ai">
                <span class="live-battle__mode-ai-text">
                  {t("replay.postbattle.aiSort")}
                  <em class="live-battle__mode-ai-hint">
                    {t("replay.postbattle.aiSortHint")}
                  </em>
                </span>
                <HkSwitch
                  modelValue={prefs.prefs.postbattleAiScore}
                  onUpdate:modelValue={(v: boolean) => prefs.setPostbattleAiScore(v)}
                />
              </div>
            ) : null}
          </div>
        </HkPopover>
      </div>
    );
  },
});
