import { defineComponent } from "vue";

import { HkSlider, HkSwitch, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  OVERLAY_BACKDROP_PCT_MAX,
  OVERLAY_BACKDROP_PCT_MIN,
  useStatsPrefsStore,
  type RosterBattleScope,
} from "@/stores/statsPrefs";
import OverlayColumnsEditor from "@/components/settings/OverlayColumnsEditor";
// Same row pattern as the stats section's preference controls (label +
// description left, control right; the sub rail for dependent clusters).
import "../stats/StatsPrefsControls.scss";
import "./OverlayContentControls.scss";

/**
 * The water-table content-selection controls (settings → 游戏内水表):
 * WHAT the per-row numbers show — the draggable column cards (scope ×
 * metric pairs, up to five — OverlayColumnsEditor; the very columns the
 * live panel, the post-battle panels and the Tab overlay's chips all
 * render), plus which battle-mode career feeds every column (follow the
 * current battle / fixed randoms / fixed ranked / the global merge), the
 * career seal stamps, and the overlay's per-team averages line (one
 * all-or-nothing switch; the consumable-intel line beside it renders
 * unconditionally and has no switch). One LOOK knob heads the card too:
 * the Tab overlay's plate-opacity dial — the only thing here that is not a
 * content selection, but it shapes exactly the plates the columns fill
 * (see the dial's own comment below). Everything reads / writes the
 * shared statsPrefs store, and every surface applies a flip immediately —
 * the panels through the store's reactivity, the overlay window through
 * the store's broadcast (it re-reads the blob live; see overlay/main.ts's
 * refreshPrefs).
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

    return () => (
      <div class="stats-prefs">
        {/* The Tab overlay's plate opacity — FIRST because it shapes
            everything below: the columns pick WHAT the chips say, this dial
            picks how solid the dark plate behind those numbers sits over
            the battle. ONE knob for every plate in that window (each chip
            and the centered status card, overlay.scss), 100% fully opaque,
            and the band's floor keeps the digits legible over a battle
            frame. The stored default (80) ships a step more solid than the
            original 62 chip glass, so an untouched install reads better
            over bright water (the status card settles onto the same value —
            one setting cannot carry two plate alphas). Live: the overlay
            window re-reads the prefs blob on the store's broadcast, so a
            drag repaints the in-game plates immediately (overlay/backdrop.ts
            writes the CSS var, overlay/main.ts's refreshPrefs re-applies
            it). */}
        <div class="stats-prefs__row">
          <span class="stats-prefs__row-text">
            <span class="stats-prefs__row-label">
              {t("settings.overlayContent.backdropOpacity")}
            </span>
            <span class="stats-prefs__row-desc">
              {t("settings.overlayContent.backdropOpacityDesc")}
            </span>
          </span>
          <div class="overlay-content__backdrop-controls">
            <HkSlider
              class="overlay-content__backdrop-slider"
              min={OVERLAY_BACKDROP_PCT_MIN}
              max={OVERLAY_BACKDROP_PCT_MAX}
              step={1}
              modelValue={prefs.prefs.overlayBackdropPct}
              onUpdate:modelValue={(v: number) => prefs.setOverlayBackdropPct(v)}
              ariaLabel={t("settings.overlayContent.backdropOpacity")}
              formatValue={(v: number) => `${v}%`}
            />
            {/* Visible readout: the slider's aria-valuetext is not a
                readout, and the thumb alone cannot be read to a percent. */}
            <span class="overlay-content__backdrop-value">
              {prefs.prefs.overlayBackdropPct}%
            </span>
          </div>
        </div>

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
          t("settings.overlayContent.avgToggle"),
          t("settings.overlayContent.avgToggleDesc"),
          prefs.prefs.teamAvgEnabled,
          (v) => prefs.setTeamAvgEnabled(v),
        )}
      </div>
    );
  },
});
