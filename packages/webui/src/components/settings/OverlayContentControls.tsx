import { defineComponent } from "vue";

import { HkSwitch, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  useStatsPrefsStore,
  type OverlayIntelToggles,
  type OverlayTeamAvgToggles,
  type RosterBattleScope,
} from "@/stores/statsPrefs";
import OverlayColumnsEditor from "@/components/settings/OverlayColumnsEditor";
// Same row pattern as the stats section's preference controls (label +
// description left, control right; the sub rail for dependent clusters).
import "../stats/StatsPrefsControls.scss";

/**
 * The water-table content-selection controls (settings → 游戏内水表):
 * WHAT the per-row numbers show — the draggable column cards (scope ×
 * metric pairs, up to five — OverlayColumnsEditor; the very columns the
 * live panel, the post-battle panels and the Tab overlay's chips all
 * render), plus which battle-mode career feeds every column (follow the
 * current battle / fixed randoms / fixed ranked / the global merge), the
 * career seal stamps, the team-intel card's items (radar / hydro /
 * smoke) and the overlay's per-team average line. Everything reads /
 * writes the shared statsPrefs store, and every surface applies a flip
 * immediately — the panels through the store's reactivity, the overlay
 * window through the store's broadcast (it re-reads the blob live; see
 * overlay/main.ts's refreshPrefs).
 */
export default defineComponent({
  name: "OverlayContentControls",
  setup() {
    const prefs = useStatsPrefsStore();

    const row = (
      label: string,
      desc: string,
      on: boolean,
      set: (v: boolean) => void,
    ) => (
      <div class="stats-prefs__row">
        <span class="stats-prefs__row-text">
          <span class="stats-prefs__row-label">{label}</span>
          <span class="stats-prefs__row-desc">{desc}</span>
        </span>
        <HkSwitch modelValue={on} onUpdate:modelValue={set} />
      </div>
    );
    const intelRow = (key: keyof OverlayIntelToggles, label: string, desc: string) =>
      row(label, desc, prefs.prefs.overlayIntel[key], (v) => prefs.setOverlayIntel(key, v));
    const avgRow = (key: keyof OverlayTeamAvgToggles, label: string, desc: string) =>
      row(label, desc, prefs.prefs.overlayTeamAvg[key], (v) => prefs.setOverlayTeamAvg(key, v));

    return () => (
      <div class="stats-prefs">
        {/* The columns themselves — draggable cards + the add connector
            (scope × metric). The column list IS the per-row content on
            every water-table surface. */}
        <OverlayColumnsEditor />

        {/* The battle-type career feeding every column — the one
            panel-wide stats-source dimension left (each column carries
            its own scope inside the cards above). */}
        <div class="stats-prefs__row">
          <span class="stats-prefs__row-text">
            <span class="stats-prefs__row-label">{t("settings.overlayContent.battleScope")}</span>
            <span class="stats-prefs__row-desc">{t("settings.overlayContent.battleScopeDesc")}</span>
          </span>
          <HkTabs
            variant="segmented"
            modelValue={prefs.prefs.overlayBattleScope}
            onUpdate:modelValue={(v: string) =>
              prefs.setOverlayBattleScope(v as RosterBattleScope)
            }
            tabs={[
              { key: "follow", label: t("settings.overlayContent.battleFollow") },
              { key: "random", label: t("settings.overlayContent.battleRandom") },
              { key: "ranked", label: t("settings.overlayContent.battleRanked") },
              { key: "all", label: t("settings.overlayContent.battleAll") },
            ]}
          />
        </div>

        {row(
          t("settings.overlayContent.sealToggle"),
          t("settings.overlayContent.sealToggleDesc"),
          prefs.prefs.sealsEnabled,
          (v) => prefs.setSealsEnabled(v),
        )}
        {/* The seals AND-compose with the PR master switch (their verdicts
            grade the rating data) — point at the stats section when the
            stamp toggle alone cannot light them up. */}
        {!prefs.prefs.prEnabled ? (
          <div class="stats-prefs__row">
            <span class="stats-prefs__row-desc">{t("settings.overlayContent.sealNeedsPr")}</span>
          </div>
        ) : null}

        {row(
          t("settings.overlayContent.intelToggle"),
          t("settings.overlayContent.intelToggleDesc"),
          prefs.prefs.teamIntelEnabled,
          (v) => prefs.setTeamIntelEnabled(v),
        )}
        {prefs.prefs.teamIntelEnabled ? (
          <div class="stats-prefs__sub">
            {intelRow("radar", t("settings.overlayContent.intelRadar"), t("settings.overlayContent.intelRadarDesc"))}
            {intelRow("hydro", t("settings.overlayContent.intelHydro"), t("settings.overlayContent.intelHydroDesc"))}
            {intelRow("smoke", t("settings.overlayContent.intelSmoke"), t("settings.overlayContent.intelSmokeDesc"))}
          </div>
        ) : null}

        {avgRow("winrate", t("settings.overlayContent.avgWinrate"), t("settings.overlayContent.avgWinrateDesc"))}
        {avgRow("pr", t("settings.overlayContent.avgPr"), t("settings.overlayContent.avgPrDesc"))}
        {avgRow("damage", t("settings.overlayContent.avgDamage"), t("settings.overlayContent.avgDamageDesc"))}
      </div>
    );
  },
});
