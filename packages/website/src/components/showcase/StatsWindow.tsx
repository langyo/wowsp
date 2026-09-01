import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, Crosshair, Gauge, Star, Swords, Trophy } from "@lucide/vue";
import { HTag } from "@celestia-island/hikari";
import "./WindowFrames.scss";

/** Mock player water-meter for the homepage intro module (anonymised sample). */
const MOCK = {
  name: "Player001",
  server: "ASIA",
  clan: "HOOD",
  rating: "战舰仙人",
  ratingDelta: "+1833",
  pr: 5083,
  metrics: { battles: 2, winRate: "100.00%", avgDmg: 128055, avgKills: "3.50", avgXp: 2157 },
  groups: [
    { key: "solo", battles: 2, pr: "神佬平均", winRate: "100.00%", dmg: 128055, kills: "3.50", xp: 2157 },
    { key: "div2", battles: null, pr: null, winRate: null, dmg: null, kills: null, xp: null },
    { key: "div3", battles: null, pr: null, winRate: null, dmg: null, kills: null, xp: null },
  ],
  ships: [
    { name: "天城", battles: 2, pr: "神佬平均", winRate: "100.00%", dmg: 128055, survival: "50.00%", hitRate: "33.89%" },
    { name: "Montana", battles: 412, pr: 1821, winRate: "58.7%", dmg: 118920, survival: "41.0%", hitRate: "31.20%" },
    { name: "Shimakaze", battles: 388, pr: 1974, winRate: "61.2%", dmg: 74210, survival: "47.5%", hitRate: "12.40%" },
  ],
};

/**
 * StatsWindow — player-stats ("水表") intro module for the homepage, styled
 * after the classic stats card: identity header, gradient PR banner, metric
 * tiles, then group / per-ship tables. Anonymised sample data.
 */
export default defineComponent({
  name: "StatsWindow",
  setup() {
    const { t } = useI18n();
    const metricIcons = [Trophy, Swords, Crosshair, Activity, Star];

    return () => (
      <div class="mod-win glass-panel stats-win">
        {/* window chrome */}
        <div class="mod-win__chrome">
          <span class="mod-win__title">
            <Gauge size={13} />
            {t("showcase.stats.win.title")}
          </span>
          <span class="mod-win__search">{t("stats.more")}</span>
        </div>

        {/* identity header */}
        <div class="stats-win__id">
          <div class="stats-win__who">
            <strong class="stats-win__name">{MOCK.name}</strong>
            <span class="stats-win__meta">{MOCK.server} · [{MOCK.clan}] · {t("stats.battleType")}</span>
          </div>
          <div class="stats-win__prbanner">
            <span class="stats-win__rating">「{t("stats.ratingName")}」</span>
            <span class="stats-win__pr">PR: {MOCK.pr.toLocaleString()}</span>
          </div>
        </div>

        {/* metric tiles */}
        <div class="stats-win__tiles">
          {([
            ["battles", MOCK.metrics.battles.toLocaleString()],
            ["winRate", MOCK.metrics.winRate],
            ["avgDmg", MOCK.metrics.avgDmg.toLocaleString()],
            ["avgKills", MOCK.metrics.avgKills],
            ["avgXp", MOCK.metrics.avgXp.toLocaleString()],
          ] as const).map(([key, val], i) => {
            const Icon = metricIcons[i];
            return (
              <span class="stats-win__tile" key={key}>
                <Icon size={13} />
                <b>{val}</b>
                <i>{t(`stats.metrics.${key}`)}</i>
              </span>
            );
          })}
        </div>

        {/* group table */}
        <div class="stats-win__sect">
          <span class="stats-win__sect-title">{t("stats.overall")}</span>
          <table class="stats-win__table">
            <thead>
              <tr>
                <th></th>
                <th class="is-num">{t("stats.cols.battles")}</th>
                <th>{t("stats.cols.pr")}</th>
                <th class="is-num">{t("stats.cols.winRate")}</th>
                <th class="is-num">{t("stats.cols.dmg")}</th>
                <th class="is-num">{t("stats.cols.kills")}</th>
                <th class="is-num">{t("stats.cols.xp")}</th>
              </tr>
            </thead>
            <tbody>
              {MOCK.groups.map((g) => (
                <tr key={g.key}>
                  <td><HTag variant="default">{t(`stats.groups.${g.key}`)}</HTag></td>
                  <td class="is-num">{g.battles ?? "-"}</td>
                  <td>{g.pr ?? "-"}</td>
                  <td class="is-num">{g.winRate ?? "-"}</td>
                  <td class="is-num">{g.dmg?.toLocaleString() ?? "-"}</td>
                  <td class="is-num">{g.kills ?? "-"}</td>
                  <td class="is-num">{g.xp?.toLocaleString() ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* per-ship table */}
        <div class="stats-win__sect">
          <span class="stats-win__sect-title">{t("stats.perShip")}</span>
          <table class="stats-win__table">
            <thead>
              <tr>
                <th>{t("stats.cols.ship")}</th>
                <th class="is-num">{t("stats.cols.battles")}</th>
                <th>{t("stats.cols.pr")}</th>
                <th class="is-num">{t("stats.cols.winRate")}</th>
                <th class="is-num">{t("stats.cols.dmg")}</th>
                <th class="is-num">{t("stats.cols.survival")}</th>
                <th class="is-num">{t("stats.cols.hitRate")}</th>
              </tr>
            </thead>
            <tbody>
              {MOCK.ships.map((s) => (
                <tr key={s.name}>
                  <td class="stats-win__shipname">{s.name}</td>
                  <td class="is-num">{s.battles}</td>
                  <td>{s.pr}</td>
                  <td class="is-num">{s.winRate}</td>
                  <td class="is-num">{s.dmg.toLocaleString()}</td>
                  <td class="is-num">{s.survival}</td>
                  <td class="is-num">{s.hitRate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
});
