import { computed, defineComponent, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Ship, Crosshair, Map, SlidersHorizontal, Volume2, Palette, Layers,
  Search, Waves, CloudFog, Radar, Timer, Crosshair as CrosshairIcon,
} from "lucide-vue-next";
import { HButton, HSwitch, HTag } from "@celestia-island/hikari";
import "./ModWindow.scss";

/** Category tabs mirror Aslain's real modpack groups (no catch-all "all"). */
const CATS = [
  { key: "icons", icon: Ship },
  { key: "crosshair", icon: Crosshair },
  { key: "minimap", icon: Map },
  { key: "helper", icon: SlidersHorizontal },
  { key: "voice", icon: Volume2 },
  { key: "skins", icon: Palette },
  { key: "packs", icon: Layers },
] as const;

type CatKey = (typeof CATS)[number]["key"];
type RowState = "enabled" | "off" | "install";

interface ModRow {
  id: string;
  cat: CatKey;
  icon: typeof Ship;
  size: string;
  version: string;
  initial: RowState;
}

/** Real entries lifted from Aslain 15.6.0 modpack (packages/…/components.json).
 *  name/desc live in the locale messages (showcase.mods.rows.*). */
const ROWS: ModRow[] = [
  { id: "aslain-icons", cat: "icons", icon: Ship, size: "4.1 MB", version: "15.6", initial: "enabled" },
  { id: "hualala-icons", cat: "icons", icon: Ship, size: "3.2 MB", version: "15.6", initial: "off" },
  { id: "golden-premium", cat: "icons", icon: Ship, size: "0.4 MB", version: "15.6", initial: "off" },
  { id: "nomogram", cat: "crosshair", icon: Crosshair, size: "0.2 MB", version: "15.6", initial: "enabled" },
  { id: "bowser-static", cat: "crosshair", icon: CrosshairIcon, size: "0.1 MB", version: "15.6", initial: "off" },
  { id: "gun-markers", cat: "crosshair", icon: CrosshairIcon, size: "0.3 MB", version: "15.6", initial: "off" },
  { id: "ttaro-minimap", cat: "minimap", icon: Map, size: "1.8 MB", version: "15.6", initial: "enabled" },
  { id: "rpf-2d", cat: "minimap", icon: Radar, size: "0.2 MB", version: "15.6", initial: "off" },
  { id: "last-spotted", cat: "minimap", icon: Timer, size: "0.1 MB", version: "15.6", initial: "off" },
  { id: "score-timer", cat: "helper", icon: Timer, size: "0.3 MB", version: "15.6", initial: "enabled" },
  { id: "pen-calc", cat: "helper", icon: CrosshairIcon, size: "0.4 MB", version: "15.6", initial: "off" },
  { id: "speed-indicator", cat: "helper", icon: Waves, size: "0.1 MB", version: "15.6", initial: "off" },
  { id: "fog-remover", cat: "helper", icon: CloudFog, size: "0.8 MB", version: "15.6", initial: "enabled" },
  { id: "kancolle-voice", cat: "voice", icon: Volume2, size: "96 MB", version: "15.6", initial: "install" },
  { id: "azur-lane-voice", cat: "voice", icon: Volume2, size: "112 MB", version: "15.6", initial: "install" },
  { id: "kizuna-voice", cat: "voice", icon: Volume2, size: "28 MB", version: "15.6", initial: "off" },
  { id: "duke-nukem", cat: "voice", icon: Volume2, size: "14 MB", version: "15.6", initial: "off" },
  { id: "full-wows-voice", cat: "voice", icon: Volume2, size: "210 MB", version: "15.6", initial: "off" },
  { id: "montana-skin", cat: "skins", icon: Palette, size: "48 MB", version: "15.6", initial: "enabled" },
  { id: "yamato-fsi", cat: "skins", icon: Palette, size: "62 MB", version: "15.6", initial: "off" },
  { id: "missouri-white", cat: "skins", icon: Palette, size: "31 MB", version: "15.6", initial: "off" },
  { id: "musashi-arp", cat: "skins", icon: Palette, size: "55 MB", version: "15.6", initial: "off" },
  { id: "arpeggio-ui", cat: "packs", icon: Layers, size: "22 MB", version: "15.6", initial: "install" },
  { id: "blue-archive-ui", cat: "packs", icon: Layers, size: "26 MB", version: "15.6", initial: "install" },
  { id: "miku-ui", cat: "packs", icon: Layers, size: "18 MB", version: "15.6", initial: "off" },
  { id: "hsf-ui", cat: "packs", icon: Layers, size: "24 MB", version: "15.6", initial: "off" },
  { id: "azurlane-dorm", cat: "packs", icon: Layers, size: "40 MB", version: "15.6", initial: "off" },
];

const ROTATE_MS = 4200;
const ROWS_PER_CAT = 4;

/**
 * ModWindow — living Mod Hub mock backed by REAL Aslain 15.6.0 entries.
 * Category tabs auto-rotate; any click pauses rotation and selects.
 */
export default defineComponent({
  name: "ModWindow",
  setup() {
    const { t, tm } = useI18n();
    const state = reactive({
      cat: 0 as number,
      rows: Object.fromEntries(ROWS.map((r) => [r.id, r.initial])) as Record<string, RowState>,
    });
    const paused = ref(false);
    const search = ref("");
    let rotHandle = 0;

    function rowText(id: string, field: "name" | "desc"): string {
      const m = tm(`showcase.mods.win.rows.${id}`) as { name?: string; desc?: string } | string;
      if (typeof m === "object" && m) return m[field] ?? "";
      return "";
    }

    const visible = computed(() => {
      const cat = CATS[state.cat].key;
      const rows = ROWS.filter((r) => r.cat === cat);
      if (!search.value) return rows.slice(0, ROWS_PER_CAT);
      const q = search.value.toLowerCase();
      return rows
        .filter((r) => `${rowText(r.id, "name")} ${rowText(r.id, "desc")}`.toLowerCase().includes(q))
        .slice(0, ROWS_PER_CAT);
    });

    const enabledCount = computed(() =>
      Object.values(state.rows).filter((s) => s === "enabled").length,
    );

    function rotate() {
      state.cat = (state.cat + 1) % CATS.length;
    }

    function selectCat(i: number) {
      state.cat = i;
      paused.value = true;
      clearInterval(rotHandle);
      rotHandle = window.setTimeout(() => {
        paused.value = false;
        rotHandle = window.setInterval(rotate, ROTATE_MS);
      }, 15000);
    }

    onMounted(() => {
      rotHandle = window.setInterval(rotate, ROTATE_MS);
    });
    onBeforeUnmount(() => clearInterval(rotHandle));

    return () => (
      <div class="mod-win glass-panel">
        {/* window chrome */}
        <div class="mod-win__chrome">
          <span class="mod-win__title">
            <Layers size={13} />
            {t("showcase.mods.win.title")}
            <HTag variant="default">{t("showcase.mods.win.aslainTag")}</HTag>
          </span>
          <span class="mod-win__search">
            <Search size={12} />
            {t("showcase.mods.win.searchHint")}
          </span>
        </div>

        {/* category tabs — auto-rotating, no catch-all */}
        <div class="mod-win__tabs" role="tablist">
          {CATS.map((c, i) => {
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={state.cat === i}
                class={["mod-win__tab", state.cat === i ? "is-active" : ""].join(" ")}
                onClick={() => selectCat(i)}
              >
                <Icon size={13} />
                {t(`showcase.mods.win.cats.${c.key}`)}
              </button>
            );
          })}
        </div>

        {/* mod rows */}
        <ul class="mod-win__list">
          {visible.value.map((row) => {
            const Icon = row.icon;
            const rowState = state.rows[row.id];
            return (
              <li class="mod-win__row" key={row.id}>
                <span class={`mod-win__icon mod-win__icon--${row.cat}`}>
                  <Icon size={16} />
                </span>
                <span class="mod-win__meta">
                  <span class="mod-win__name">
                    {rowText(row.id, "name")}
                    <HTag variant={row.cat === "voice" ? "warning" : row.cat === "skins" ? "primary" : "default"}>
                      {row.version}
                    </HTag>
                  </span>
                  <span class="mod-win__desc">{rowText(row.id, "desc")} · {row.size}</span>
                </span>
                <span class="mod-win__action">
                  {rowState === "install" ? (
                    <HButton size="sm" onClick={() => { state.rows[row.id] = "enabled"; }}>
                      {t("showcase.mods.win.install")}
                    </HButton>
                  ) : (
                    <HSwitch
                      modelValue={rowState === "enabled"}
                      onUpdate:modelValue={(v: boolean) => { state.rows[row.id] = v ? "enabled" : "off"; }}
                      aria-label={rowText(row.id, "name")}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        {/* status bar */}
        <div class="mod-win__status">
          <span class="mod-win__status-dot" />
          {t("showcase.mods.win.status", { count: enabledCount.value })}
        </div>
      </div>
    );
  },
});
