import { defineComponent, type PropType } from "vue";

import { HkSwitch, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useStatsPrefsStore, type PrAlgo } from "@/stores/statsPrefs";
import "./StatsPrefsControls.scss";

/**
 * The water-table preference controls (PR rating master switch →
 * algorithm / team-winrate weighting / stamps / localized tier wording),
 * reading and writing the shared statsPrefs store. One component, two
 * hosts: the onboarding wizard's preferences step and the settings modal's
 * 战绩 section render the identical control set through the `ns` prop —
 * the two surfaces carry their own (differently worded) i18n copies whose
 * keys are kept in sync (onboarding.json top level ↔ settings.json
 * `statsPrefs` sub-object). The hold-Tab overlay's content switches live
 * in their own group on the settings' 游戏内水表 section (see
 * OverlayContentControls), not here.
 *
 * Layout mirrors the settings modal's row pattern: label + description on
 * the left, control on the right; the four sub-controls only exist while
 * the master switch is on.
 */
export default defineComponent({
  name: "StatsPrefsControls",
  props: {
    ns: {
      type: String as PropType<"onboarding" | "settings">,
      default: "settings",
    },
  },
  setup(props) {
    const prefs = useStatsPrefsStore();
    const tr = (key: string) =>
      t(props.ns === "onboarding" ? `onboarding.${key}` : `settings.statsPrefs.${key}`);

    return () => (
      <div class="stats-prefs">
        <div class="stats-prefs__row">
          <span class="stats-prefs__row-text">
            <span class="stats-prefs__row-label">{tr("prToggle")}</span>
            <span class="stats-prefs__row-desc">{tr("prToggleDesc")}</span>
          </span>
          <HkSwitch
            modelValue={prefs.prefs.prEnabled}
            onUpdate:modelValue={(v: boolean) => prefs.setPrEnabled(v)}
          />
        </div>

        {/* Karma (业力 — the WG net like/report count) switches sit OUTSIDE
            the PR master's cluster: karma is identity metadata, not a rating,
            so both stay reachable while the PR rating is off. The roster one
            covers the live + post-battle player lists, the card one the
            stats cards' identity head (我的水表 / lookup). */}
        <div class="stats-prefs__row">
          <span class="stats-prefs__row-text">
            <span class="stats-prefs__row-label">{tr("rosterKarmaToggle")}</span>
            <span class="stats-prefs__row-desc">{tr("rosterKarmaToggleDesc")}</span>
          </span>
          <HkSwitch
            modelValue={prefs.prefs.rosterKarmaEnabled}
            onUpdate:modelValue={(v: boolean) => prefs.setRosterKarmaEnabled(v)}
          />
        </div>
        <div class="stats-prefs__row">
          <span class="stats-prefs__row-text">
            <span class="stats-prefs__row-label">{tr("cardKarmaToggle")}</span>
            <span class="stats-prefs__row-desc">{tr("cardKarmaToggleDesc")}</span>
          </span>
          <HkSwitch
            modelValue={prefs.prefs.cardKarmaEnabled}
            onUpdate:modelValue={(v: boolean) => prefs.setCardKarmaEnabled(v)}
          />
        </div>

        {/* Sub-controls exist only while the rating is on — collapsing the
            cluster keeps the off state to a single honest switch. */}
        {prefs.prefs.prEnabled ? (
          <div class="stats-prefs__sub">
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">{tr("prAlgo")}</span>
                <span class="stats-prefs__row-desc">{tr("prAlgoDesc")}</span>
              </span>
              <HkTabs
                variant="segmented"
                modelValue={prefs.prefs.prAlgo}
                onUpdate:modelValue={(v: string) => prefs.setPrAlgo(v as PrAlgo)}
                tabs={[
                  { key: "winrate", label: tr("prAlgoWinrate") },
                  { key: "expected", label: tr("prAlgoExpected") },
                ]}
              />
            </div>
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">{tr("teamWrToggle")}</span>
                <span class="stats-prefs__row-desc">{tr("teamWrToggleDesc")}</span>
              </span>
              <HkSwitch
                modelValue={prefs.prefs.weightedTeamWr}
                onUpdate:modelValue={(v: boolean) => prefs.setWeightedTeamWr(v)}
              />
            </div>
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">{tr("sealsToggle")}</span>
                <span class="stats-prefs__row-desc">{tr("sealsToggleDesc")}</span>
              </span>
              <HkSwitch
                modelValue={prefs.prefs.sealsEnabled}
                onUpdate:modelValue={(v: boolean) => prefs.setSealsEnabled(v)}
              />
            </div>
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">{tr("localizedTiersToggle")}</span>
                <span class="stats-prefs__row-desc">{tr("localizedTiersToggleDesc")}</span>
              </span>
              <HkSwitch
                modelValue={prefs.prefs.localizedTiers}
                onUpdate:modelValue={(v: boolean) => prefs.setLocalizedTiers(v)}
              />
            </div>
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">{tr("prTintToggle")}</span>
                <span class="stats-prefs__row-desc">{tr("prTintToggleDesc")}</span>
              </span>
              <HkSwitch
                modelValue={prefs.prefs.liveRosterPrTint}
                onUpdate:modelValue={(v: boolean) => prefs.setLiveRosterPrTint(v)}
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  },
});
