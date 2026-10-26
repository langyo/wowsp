/**
 * The per-player build grid inside the LiveShipMeta hover card (live roster
 * and post-battle panels both mount it through that component).
 *
 * Four sections, each rendered only when the decoded build actually carries
 * that field: captain skills (the class tree's four tier rows with the picked
 * cells lit, plus the X/21 point tally), mounted upgrades (in-game slot
 * order), signal flags, and the mounted consumables with their battle keys.
 * Icons come from the baked in-game art; every tile carries a data-hint so
 * the global tooltip explains it (the same delegated mechanism the rest of
 * the app uses). Purely presentational: playerBuild.ts owns all joins and
 * translations, so this component has no data-source logic.
 */
import { defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import { AssetImage } from "@/components/base/AssetImage";
import { tierRoman } from "./shipLiveStats";
import { playerBuildHasContent, type PlayerBuildView } from "./playerBuild";
import "./PlayerBuildGrid.scss";

export default defineComponent({
  name: "PlayerBuildGrid",
  props: {
    view: { type: Object as PropType<PlayerBuildView>, required: true },
  },
  setup(props) {
    const sourceLabel = () =>
      t(
        props.view.source === "probe"
          ? "replay.live.build.sourceProbe"
          : "replay.live.build.sourceReplay",
      );

    const skillsSection = () => {
      const view = props.view;
      if (view.skills.length === 0 && view.unplacedSkills.length === 0) return null;
      return (
        <section class="player-build__section player-build__section--skills">
          <h4 class="player-build__section-title">
            <span>{t("replay.live.build.skills")}</span>
            <span class="player-build__points">
              {t("replay.live.build.points", { used: view.skillPoints })}
            </span>
          </h4>
          <div class="player-build__skill-tree">
            {view.skillRows.map((row) => (
              <div class="player-build__skill-row" key={row.tier}>
                <span class="player-build__tier">{tierRoman(row.tier)}</span>
                {row.cells.map((cell, column) =>
                  cell ? (
                    <span
                      class="player-build__tile player-build__tile--picked"
                      key={cell.code}
                      data-hint={cell.hint}
                    >
                      <AssetImage
                        class="player-build__icon"
                        src={cell.iconUrl}
                        alt={cell.label}
                        fallback={<span class="player-build__glyph">{cell.label.slice(0, 1)}</span>}
                      />
                    </span>
                  ) : (
                    <span
                      class="player-build__tile player-build__tile--empty"
                      key={"empty-" + row.tier + "-" + column}
                    />
                  ),
                )}
              </div>
            ))}
            {view.unplacedSkills.length > 0 ? (
              <div class="player-build__chips">
                {view.unplacedSkills.map((skill) => (
                  <span class="player-build__chip" key={skill.code} data-hint={skill.hint}>
                    {skill.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      );
    };

    const upgradesSection = () => {
      const view = props.view;
      if (view.upgrades.length === 0) return null;
      return (
        <section class="player-build__section player-build__section--upgrades">
          <h4 class="player-build__section-title">
            <span>{t("replay.live.build.upgrades")}</span>
            <span class="player-build__count">{view.upgrades.length}</span>
          </h4>
          <div class="player-build__row">
            {view.upgrades.map((upgrade) => (
              <span
                class="player-build__tile player-build__tile--slot"
                key={upgrade.code}
                data-hint={upgrade.hint}
              >
                <span class="player-build__slot-no">{upgrade.slot + 1}</span>
                <AssetImage
                  class="player-build__icon"
                  src={upgrade.iconUrl}
                  alt={upgrade.label}
                  fallback={<span class="player-build__glyph">{upgrade.label.slice(0, 1)}</span>}
                />
              </span>
            ))}
          </div>
        </section>
      );
    };

    const signalsSection = () => {
      const view = props.view;
      if (view.signals.length === 0) return null;
      return (
        <section class="player-build__section player-build__section--signals">
          <h4 class="player-build__section-title">
            <span>{t("replay.live.build.signals")}</span>
            <span class="player-build__count">{view.signals.length}</span>
          </h4>
          <div class="player-build__row player-build__row--wrap">
            {view.signals.map((signal) => (
              <span
                class="player-build__tile player-build__tile--signal"
                key={signal.index}
                data-hint={signal.hint}
              >
                <AssetImage
                  class="player-build__icon"
                  src={signal.iconUrl}
                  alt={signal.label}
                  fallback={<span class="player-build__glyph">{signal.label.slice(0, 1)}</span>}
                />
              </span>
            ))}
          </div>
        </section>
      );
    };

    const consumablesSection = () => {
      const view = props.view;
      if (view.consumables.length === 0) return null;
      return (
        <section class="player-build__section player-build__section--consumables">
          <h4 class="player-build__section-title">
            <span>{t("replay.live.build.consumables")}</span>
            <span class="player-build__count">{view.consumables.length}</span>
          </h4>
          <div class="player-build__row">
            {view.consumables.map((item) => (
              <span
                class="player-build__tile player-build__tile--consumable"
                key={item.slot + "-" + item.family}
                data-hint={item.label}
              >
                {item.key ? <span class="player-build__key">{item.key}</span> : null}
                <AssetImage
                  class="player-build__icon"
                  src={item.iconUrl}
                  alt={item.label}
                  fallback={<span class="player-build__glyph">{item.label.slice(0, 1)}</span>}
                />
              </span>
            ))}
          </div>
        </section>
      );
    };

    return () => {
      if (!playerBuildHasContent(props.view)) return null;
      return (
        <section class="player-build" aria-label={t("replay.live.build.title")}>
          <header class={["player-build__head", "player-build__head--" + props.view.source]}>
            <span class="player-build__title">{t("replay.live.build.title")}</span>
            <span class="player-build__source">{sourceLabel()}</span>
            {props.view.inAdaptation ? (
              <span class="player-build__note">{t("replay.live.build.retraining")}</span>
            ) : null}
          </header>
          {skillsSection()}
          {upgradesSection()}
          {signalsSection()}
          {consumablesSection()}
        </section>
      );
    };
  },
});
