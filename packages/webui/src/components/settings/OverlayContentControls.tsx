import { defineComponent } from "vue";

import { HkSwitch, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  useStatsPrefsStore,
  type OverlayChipToggles,
  type OverlayIntelToggles,
  type OverlayTeamAvgToggles,
  type RosterBattleScope,
  type RosterShipScope,
  type RosterSoloScope,
} from "@/stores/statsPrefs";
// Same row pattern as the stats section's preference controls (label +
// description left, control right; the sub rail for dependent clusters).
import "../stats/StatsPrefsControls.scss";

/**
 * The water-table content-selection controls (settings → 游戏内水表):
 * what the per-row numbers show — on the in-game Tab overlay's chips AND
 * the roster panels' columns alike (winrate / PR / battles / avg damage,
 * any combination) — plus which battle-mode career feeds them (follow the
 * current battle / fixed randoms / fixed ranked / the global merge), the
 * career seal stamps, the team-intel card's items (radar / hydro / smoke)
 * and the overlay's per-team average line. Everything reads/writes the
 * shared statsPrefs store — the overlay window re-reads the blob the next
 * time it is created, so a flip applies there from the next battle (or
 * window recreate); the main-window panels apply it immediately.
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
    const chipRow = (key: keyof OverlayChipToggles, label: string, desc: string) =>
      row(label, desc, prefs.prefs.overlayChips[key], (v) => prefs.setOverlayChip(key, v));
    const intelRow = (key: keyof OverlayIntelToggles, label: string, desc: string) =>
      row(label, desc, prefs.prefs.overlayIntel[key], (v) => prefs.setOverlayIntel(key, v));
    const avgRow = (key: keyof OverlayTeamAvgToggles, label: string, desc: string) =>
      row(label, desc, prefs.prefs.overlayTeamAvg[key], (v) => prefs.setOverlayTeamAvg(key, v));

    return () => (
      <div class="stats-prefs">
        {chipRow("winrate", t("settings.overlayContent.chipsWinrate"), t("settings.overlayContent.chipsWinrateDesc"))}
        {chipRow("pr", t("settings.overlayContent.chipsPr"), t("settings.overlayContent.chipsPrDesc"))}
        {chipRow("battles", t("settings.overlayContent.chipsBattles"), t("settings.overlayContent.chipsBattlesDesc"))}
        {chipRow("damage", t("settings.overlayContent.chipsDamage"), t("settings.overlayContent.chipsDamageDesc"))}

        {/* The stats source is THREE orthogonal dimensions — ship scope /
            battle scope / solo filter — the same groups the live panel
            head's mode tag hosts (one shared store, both stay in sync). */}
        <div class="stats-prefs__row">
          <span class="stats-prefs__row-text">
            <span class="stats-prefs__row-label">{t("settings.overlayContent.shipScope")}</span>
            <span class="stats-prefs__row-desc">{t("settings.overlayContent.shipScopeDesc")}</span>
          </span>
          <HkTabs
            variant="segmented"
            modelValue={prefs.prefs.overlayShipScope}
            onUpdate:modelValue={(v: string) =>
              prefs.setOverlayShipScope(v as RosterShipScope)
            }
            tabs={[
              { key: "all", label: t("settings.overlayContent.shipScopeAll") },
              { key: "class", label: t("settings.overlayContent.shipScopeClass") },
              { key: "tier", label: t("settings.overlayContent.shipScopeTier") },
              { key: "ship", label: t("settings.overlayContent.shipScopeShip") },
            ]}
          />
        </div>
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
        <div class="stats-prefs__row">
          <span class="stats-prefs__row-text">
            <span class="stats-prefs__row-label">{t("settings.overlayContent.soloScope")}</span>
            <span class="stats-prefs__row-desc">{t("settings.overlayContent.soloScopeDesc")}</span>
          </span>
          <HkTabs
            variant="segmented"
            modelValue={prefs.prefs.overlaySoloScope}
            onUpdate:modelValue={(v: string) =>
              prefs.setOverlaySoloScope(v as RosterSoloScope)
            }
            tabs={[
              { key: "all", label: t("settings.overlayContent.soloAll") },
              { key: "solo", label: t("settings.overlayContent.soloOnly") },
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
