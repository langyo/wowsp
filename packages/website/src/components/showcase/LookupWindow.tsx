import { computed, defineComponent, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Search, Database, Ship } from "lucide-vue-next";
import { UiTag } from "@/components/ui";
import { ships, shipName, nationFlag } from "@/data/ships";
import "./WindowFrames.scss";

/** Default rows: a few iconic hulls from the real 1168-ship roster. */
const SHOWCASE_NAMES = ["Montana", "Yamato", "Shimakaze", "Hakuryū", "Des Moines", "Gato"];
/** Rows shown at most (the module is a taste of the full table). */
const MAX_ROWS = 8;

/**
 * LookupWindow — ship-database intro module for the homepage, styled after
 * the classic ship-tool table: a live search against the REAL 15.6 roster
 * and a compact result table (tier / class / nation / name / HP).
 */
export default defineComponent({
  name: "LookupWindow",
  setup() {
    const { t, locale } = useI18n();
    const q = ref("");

    const rows = computed(() => {
      const query = q.value.trim().toLowerCase();
      if (!query) {
        return SHOWCASE_NAMES.map((n) => ships.find((s) => s.n.en === n)).filter(Boolean);
      }
      return ships
        .filter((s) => `${s.n.en} ${shipName(s, locale.value)}`.toLowerCase().includes(query))
        .slice(0, MAX_ROWS);
    });

    return () => (
      <div class="mod-win glass-panel lookup-win">
        {/* window chrome */}
        <div class="mod-win__chrome">
          <span class="mod-win__title">
            <Ship size={13} />
            {t("showcase.lookup.win.title")}
            <UiTag tone="primary">{t("showcase.lookup.win.count", { n: ships.length })}</UiTag>
          </span>
          <span class="mod-win__search">
            <Database size={12} />
            15.6
          </span>
        </div>

        {/* functional search pill (queries the real roster) */}
        <div class="lookup-win__searchrow">
          <Search size={14} />
          <input
            class="lookup-win__input"
            type="search"
            value={q.value}
            placeholder={t("showcase.lookup.win.placeholder")}
            onInput={(e) => { q.value = (e.target as HTMLInputElement).value; }}
          />
        </div>

        {/* result table (ship-tool style) */}
        <div class="lookup-win__tablewrap">
          <table class="lookup-win__table">
            <thead>
              <tr>
                <th class="is-num">{t("lookup.cols.tier")}</th>
                <th>{t("lookup.cols.type")}</th>
                <th>{t("lookup.cols.nation")}</th>
                <th>{t("lookup.cols.name")}</th>
                <th class="is-num">{t("lookup.cols.hp")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.value.map((s) => s && (
                <tr key={s.id}>
                  <td class="is-num">
                    <span class={["lookup-win__tier", s.tier >= 10 ? "is-top" : ""].join(" ")}>{s.tier}</span>
                  </td>
                  <td>{t(`lookup.types.${s.type}`)}</td>
                  <td>
                    <span class="lookup-win__nation">
                      <span class="lookup-win__flag">{nationFlag(s.nation)}</span>
                      {t(`lookup.nations.${s.nation}`)}
                    </span>
                  </td>
                  <td class="lookup-win__namecell">
                    {shipName(s, locale.value)}
                    {shipName(s, locale.value) !== s.n.en ? (
                      <span class="lookup-win__sub">{s.n.en}</span>
                    ) : null}
                  </td>
                  <td class="is-num">{s.hp ? s.hp.toLocaleString() : "—"}</td>
                </tr>
              ))}
              {rows.value.length === 0 ? (
                <tr><td class="lookup-win__empty" colspan={5}>{t("lookup.empty")}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
});
