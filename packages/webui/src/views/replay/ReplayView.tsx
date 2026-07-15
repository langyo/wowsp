import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap from "@/features/holographic/HolographicMap";
import { api } from "@/api";
import type { EntityTrajectory, GameInstallKind, PlayerStats, ShipInfo } from "@/api";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { winrateColor } from "@/utils/winrate";
import { modeColor } from "@/utils/modeColors";
import { SHIP_TYPE_SHORT } from "@/utils/shipAggregation";
import SButton from "@/components/base/SButton";
import SSelect, { type SelectOption } from "@/components/base/SSelect";
import SSpinner from "@/components/base/SSpinner";
import type { VehicleEntry } from "@/api";
import "./ReplayView.scss";

/** Map a client kind to its localized label (e.g. Steam / 官服 / Lesta / 国服). */
function kindLabel(kind: GameInstallKind | null | undefined): string {
  if (!kind) return "";
  return t(`common.game.kind.${kind}`);
}

/** Build a short label for a client selector option: "Steam · ASIA". */
function installLabel(kind: GameInstallKind, realm?: string | null): string {
  const parts = [kindLabel(kind)];
  if (realm) parts.push(realm.toUpperCase());
  return parts.join(" · ");
}

/** The replays subfolder of a client install. WoWS writes replays under
 *  `<install>/replays/`. */
function replaysDir(installPath: string): string {
  const trimmed = installPath.replace(/[\\/]+$/, "");
  return `${trimmed}/replays`;
}

/** Localize a replay matchGroup ("pvp"/"ranked"/…) with a generic fallback. */
function modeLabel(group?: string | null): string {
  if (!group) return t("replay.mode._fallback");
  const key = `replay.mode.${group}`;
  const lbl = t(key);
  // t() returns the key when missing — fall back to the generic battle label.
  return lbl === key ? t("replay.mode._fallback") : lbl;
}

/** Resolve a map's localized display name from its internal space id (e.g.
 *  "18_NE_ice_islands" → "冰之岛"/"Islands of Ice"). Space ids often DON'T
 *  match the display name (WG renamed maps but kept the internal id — e.g.
 *  "38_Canada" is "Shatter"/"碎裂"), so this lookup is authoritative. Falls
 *  back to the raw id, then to the unknown-map label. */
function displayMapName(spaceId?: string | null): string {
  if (!spaceId) return t("replay.map.unknown");
  const key = `replay.map.names.${spaceId}`;
  const lbl = t(key);
  return lbl === key ? spaceId : lbl;
}

/** Format a `YYYYMMDD[_HHMMSS]` timestamp from the replay filename into a
 *  locale-friendly date(+time) string. Returns "—" if unparseable. */
function formatDateTime(dt?: string | null): string {
  if (!dt) return "—";
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:_(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return dt;
  const [, y, mo, d, hh, mm] = m;
  const hhmm = hh ? ` ${hh}:${mm}` : "";
  return `${y}-${mo}-${d}${hhmm}`;
}

/**
 * Standalone review view (Mode 1). The left rail lists replays as info cards
 * indexed by match time / mode / own ship / map; picking one opens the detail
 * view: a holographic battle map, the recorder's ship as a holographic model,
 * and an enriched roster (this-match ship + ship type + on-demand avg stats).
 */
export default defineComponent({
  name: "ReplayView",
  setup() {
    const parser = useReplayParser();
    const gd = useGameDetect();
    const accounts = useAccountStore();
    const stats = useStatsStore();
    const encyclopedia = useEncyclopediaStore();

    // Client-selector options derived from detected installs.
    const clientOptions = computed<SelectOption[]>(() =>
      gd.config.installs.map((i) => ({
        value: i.path,
        label: installLabel(i.kind, i.realm),
      })),
    );
    const activePath = computed(() => gd.config.activeInstall?.path ?? "");
    const hasClient = computed(() => gd.config.installs.length > 0);

    /** The realm to query player stats against. Prefer the client install's
     *  realm, then the bound account's realm, else the UI default. */
    const realm = computed(
      () =>
        gd.config.activeInstall?.realm ??
        accounts.activeAccount?.realm ??
        accounts.activeRealm ??
        "asia",
    );

    /** Reload the replay list from the given (or active) client's replays dir. */
    async function reload(path?: string) {
      const dir = path ? replaysDir(path) : activePath.value ? replaysDir(activePath.value) : undefined;
      try {
        await parser.refreshList(dir);
      } catch {
        // surfaced via store.error; list stays empty
      }
    }

    onMounted(async () => {
      await gd.detect();
      await reload();
      // Warm the encyclopedia so ship names/types resolve for every roster.
      void encyclopedia.load(realm.value).catch(() => {});
    });

    // When the user picks a different client, update the store + reload.
    async function onSelectClient(path: string) {
      await gd.config.selectInstall(path);
      await reload(path);
    }

    // If the active install changes externally (e.g. a rescan), reload.
    watch(activePath, (p, prev) => {
      if (p && p !== prev) void reload(p);
    });

    const allies = computed<VehicleEntry[]>(
      () => parser.current.value?.vehicles.filter((v) => v.relation <= 1) ?? [],
    );
    const enemies = computed<VehicleEntry[]>(
      () => parser.current.value?.vehicles.filter((v) => v.relation > 1) ?? [],
    );

    /** Ref on the scrollable main section so we can reset scrollTop when
     *  switching replays — otherwise it stays at the roster position and the
     *  map/meta above scrolls out of view. */
    const mainRef = ref<HTMLElement | null>(null);
    watch(
      () => parser.current.value?.path,
      () => {
        if (mainRef.value) mainRef.value.scrollTop = 0;
      },
    );

    // Decoded trajectories for the currently-open replay (M3). Loaded lazily on
    // open so the header parse stays fast; the decode is the expensive step.
    const trajectories = ref<EntityTrajectory[]>([]);
    const trajectoryError = ref<string | null>(null);
    /** Match duration (seconds) — the max sample time across all trajectories.
     *  Only knowable after the packet stream is decoded; shown in the detail. */
    const duration = ref(0);
    watch(
      () => parser.current.value?.path,
      async (path) => {
        trajectories.value = [];
        trajectoryError.value = null;
        duration.value = 0;
        if (!path) return;
        try {
          trajectories.value = await api.readReplayPositions(path);
          let maxT = 0;
          for (const tr of trajectories.value) {
            for (const s of tr.samples) if (s.time > maxT) maxT = s.time;
          }
          duration.value = maxT;
        } catch (e) {
          trajectoryError.value = (e as Error).message;
        }
      },
    );

    /** Format a match duration (seconds) as M:SS or H:MM:SS. */
    function formatDuration(sec: number): string {
      if (!sec || sec <= 0) return "—";
      const s = Math.round(sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      const pad = (n: number) => String(n).padStart(2, "0");
      return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
    }

    /** Resolve a roster vehicle's ShipInfo (for ship type/name back-fill). */
    function shipOf(v: VehicleEntry): ShipInfo | null {
      return encyclopedia.byId.get(v.shipId) ?? null;
    }
    function shipTypeShort(v: VehicleEntry): string {
      const info = shipOf(v);
      return (info ? SHIP_TYPE_SHORT[info.type] : null) ?? "?";
    }
    function shipDisplayName(v: VehicleEntry): string {
      return shipOf(v)?.name ?? v.shipName ?? v.name ?? `#${v.shipId}`;
    }

    /** Extract a ship's max HP from the encyclopedia defaultProfile. The
     *  baked profile carries hull.health as the stock hull's max HP — enough
     *  for a relative HP bar (live HP during the match is not decoded from
     *  the replay packet stream). */
    function shipHp(v: VehicleEntry): number {
      const dp = shipOf(v)?.defaultProfile as { hull?: { health?: number } } | undefined;
      return dp?.hull?.health ?? 0;
    }

    /** Total max HP per team (for the roster header). 0 if the encyclopedia
     *  hasn't loaded yet — the header shows the HP only when resolvable. */
    const allyTotalHp = computed(() => allies.value.reduce((s, v) => s + shipHp(v), 0));
    const enemyTotalHp = computed(() => enemies.value.reduce((s, v) => s + shipHp(v), 0));

    /** The max single-ship HP within a team — the denominator for HP-bar
     *  widths (the tankiest ship fills the bar, others scale down). */
    function maxHpIn(rows: VehicleEntry[]): number {
      return rows.reduce((m, v) => Math.max(m, shipHp(v)), 0) || 1;
    }

    const refreshing = ref(false);
    async function onRefresh() {
      refreshing.value = true;
      try {
        await reload();
      } finally {
        refreshing.value = false;
      }
    }

    /** Per-player avg-stats cache for the open replay (keyed by name). Looked
     *  up lazily on hover via lookupByName — one WG call per player, on demand. */
    const statsCache = ref<Map<string, PlayerStats>>(new Map());
    const loadingNames = ref<Set<string>>(new Set());
    const failedNames = ref<Set<string>>(new Set());
    async function lookupByName(name: string) {
      if (!name || statsCache.value.has(name) || loadingNames.value.has(name)) return;
      loadingNames.value = new Set(loadingNames.value).add(name);
      try {
        const s = await stats.lookup(name, realm.value);
        statsCache.value = new Map(statsCache.value).set(name, s);
      } catch {
        failedNames.value = new Set(failedNames.value).add(name);
      } finally {
        const next = new Set(loadingNames.value);
        next.delete(name);
        loadingNames.value = next;
      }
    }
    // Reset the stats cache whenever the open replay changes.
    watch(
      () => parser.current.value?.path,
      () => {
        statsCache.value = new Map();
        loadingNames.value = new Set();
        failedNames.value = new Set();
      },
    );

    const currentPath = computed(() => parser.current.value?.path ?? "");

    return () => (
      <main class="replay-view">
        <aside class="replay-view__list">
          <div class="replay-view__list-head">
            <div class="replay-view__list-head-row">
              <h2 class="replay-view__list-title">{t("replay.list.title")}</h2>
              <SButton
                size="sm"
                variant="ghost"
                disabled={!hasClient.value || refreshing.value}
                onClick={() => void onRefresh()}
                title={t("replay.refresh")}
              >
                <RefreshCw size={14} class={refreshing.value ? "replay-view__spin" : ""} />
              </SButton>
            </div>

            {hasClient.value ? (
              <SSelect
                size="sm"
                block
                modelValue={activePath.value}
                onUpdate:modelValue={(v: string) => void onSelectClient(v)}
                options={clientOptions.value}
                placeholder={t("replay.client")}
              />
            ) : (
              <p class="replay-view__no-client">{t("replay.list.noClient")}</p>
            )}

            {parser.list.value.length > 0 ? (
              <span class="replay-view__count">
                {t("replay.list.count", { n: parser.list.value.length })}
              </span>
            ) : null}
          </div>

          <div class="replay-view__list-scroll">
            {!hasClient.value ? (
              <p class="replay-view__empty">{t("replay.list.noClient")}</p>
            ) : parser.list.value.length === 0 ? (
              <p class="replay-view__empty">{t("replay.list.empty")}</p>
            ) : (
              <ul class="replay-view__items">
                {parser.list.value.map((r) => (
                  <li key={r.path} class="replay-view__item">
                    <button
                      type="button"
                      class={[
                        "replay-card",
                        currentPath.value === r.path ? "replay-card--active" : "",
                      ]}
                      onClick={() => parser.open(r.path)}
                    >
                      <div class="replay-card__top">
                        <span class="replay-card__ship">
                          {r.ownShipName ?? t("replay.ownShip")}
                        </span>
                        {r.matchGroup ? (
                          <span class="replay-card__pill" style={modeColor(r.matchGroup)}>
                            {modeLabel(r.matchGroup)}
                          </span>
                        ) : null}
                      </div>
                      <div class="replay-card__row">
                        <span class="replay-card__label">{t("replay.matchTime")}</span>
                        <span class="replay-card__val">{formatDateTime(r.dateTime)}</span>
                      </div>
                      <div class="replay-card__row">
                        <span class="replay-card__label">{t("replay.mapLabel")}</span>
                        <span class="replay-card__val">{displayMapName(r.mapName)}</span>
                      </div>
                      <div class="replay-card__foot">
                        <span class="replay-card__players">
                          {t("replay.players", { n: r.playerCount })}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section ref={mainRef} class="replay-view__main">
          {parser.current.value ? (
            <div class="replay-view__content">
              {parser.loading.value ? (
                <div class="replay-view__loading-overlay" aria-busy="true">
                  <SSpinner size="sm" text={t("replay.loading")} />
                </div>
              ) : null}
              {parser.error.value ? (
                <div class="replay-view__placeholder replay-view__placeholder--error">
                  {parser.error.value}
                </div>
              ) : null}
              <header class="replay-view__meta">
                <strong class="replay-view__map">
                  {displayMapName(parser.current.value.mapName)}
                </strong>
                <span class="replay-view__meta-item">
                  {formatDateTime(parser.current.value.dateTime)}
                </span>
                {parser.current.value.matchGroup ? (
                  <span
                    class="replay-view__meta-item replay-view__pill"
                    style={modeColor(parser.current.value.matchGroup)}
                  >
                    {modeLabel(parser.current.value.matchGroup)}
                  </span>
                ) : null}
                <span class="replay-view__meta-item replay-view__count">
                  {t("replay.players", { n: parser.current.value.vehicles.length })}
                </span>
                {duration.value > 0 ? (
                  <span class="replay-view__meta-item">
                    {t("replay.duration")}: <strong>{formatDuration(duration.value)}</strong>
                  </span>
                ) : null}
              </header>

              <div class="replay-view__detail">
                {/* Holographic battle map — every ship rendered as its own 3D
                    model (or a tier/nation/type fallback), tinted by team role
                    (self=green / ally=blue / enemy=yellow). No separate ship
                    preview panel; the recorder's own ship lives on the map. */}
                <div class="replay-view__map-wrap">
                  {trajectoryError.value ? (
                    <div class="replay-view__placeholder replay-view__placeholder--error">
                      trajectory decode failed: {trajectoryError.value}
                    </div>
                  ) : (
                    <HolographicMap
                      replayPath={parser.current.value.path}
                      trajectories={trajectories.value}
                      vehicles={parser.current.value.vehicles}
                      encyclopedia={encyclopedia.byId.value}
                      mapId={parser.current.value.mapName ?? ""}
                    />
                  )}
                </div>
              </div>

              <div class="replay-view__roster">
                <RosterColumn
                  title={t("replay.roster.allies")}
                  rows={allies.value}
                  kind="ally"
                  totalHp={allyTotalHp.value}
                  maxHp={maxHpIn(allies.value)}
                  shipHp={shipHp}
                  shipTypeShort={shipTypeShort}
                  shipDisplayName={shipDisplayName}
                  statsCache={statsCache.value}
                  loadingNames={loadingNames.value}
                  failedNames={failedNames.value}
                  onHoverPlayer={(n) => void lookupByName(n)}
                />
                <RosterColumn
                  title={t("replay.roster.enemies")}
                  rows={enemies.value}
                  kind="enemy"
                  totalHp={enemyTotalHp.value}
                  maxHp={maxHpIn(enemies.value)}
                  shipHp={shipHp}
                  shipTypeShort={shipTypeShort}
                  shipDisplayName={shipDisplayName}
                  statsCache={statsCache.value}
                  loadingNames={loadingNames.value}
                  failedNames={failedNames.value}
                  onHoverPlayer={(n) => void lookupByName(n)}
                />
              </div>
            </div>
          ) : parser.loading.value ? (
            <div class="replay-view__placeholder">
              <SSpinner center size="lg" text={t("replay.loading")} />
            </div>
          ) : parser.error.value ? (
            <div class="replay-view__placeholder replay-view__placeholder--error">
              {parser.error.value}
            </div>
          ) : (
            <div class="replay-view__placeholder">{t("replay.select")}</div>
          )}
        </section>
      </main>
    );
  },
});

/** Format an HP value compactly: 392500 → "392.5k", 96000 → "96.0k". */
function formatHp(hp: number): string {
  if (hp >= 1000) return `${(hp / 1000).toFixed(1)}k`;
  return String(hp);
}

/** A roster column: each row shows the player's name + this-match ship + an
 *  HP bar (max HP relative to the team's tankiest ship). Hovering a row shows
 *  a compact stats tooltip that lazily fetches the player's average WG stats. */
const RosterColumn = defineComponent({
  name: "RosterColumn",
  props: {
    title: { type: String, required: true },
    rows: { type: Array as () => VehicleEntry[], required: true },
    kind: { type: String as () => "ally" | "enemy", required: true },
    /** Summed max HP of the whole team — shown in the column header. */
    totalHp: { type: Number, default: 0 },
    /** Max single-ship HP in the team — denominator for HP-bar widths. */
    maxHp: { type: Number, default: 1 },
    /** Helper: resolve a vehicle's max HP from the encyclopedia. */
    shipHp: { type: Function as unknown as () => (v: VehicleEntry) => number, required: true },
    shipTypeShort: { type: Function as unknown as () => (v: VehicleEntry) => string, required: true },
    shipDisplayName: { type: Function as unknown as () => (v: VehicleEntry) => string, required: true },
    statsCache: { type: Object as () => Map<string, PlayerStats>, required: true },
    loadingNames: { type: Object as () => Set<string>, required: true },
    failedNames: { type: Object as () => Set<string>, required: true },
  },
  emits: { hoverPlayer: (_name: string) => true },
  setup(props, { emit }) {
    // Hover-tooltip state (position:fixed, anchored to the hovered row — same
    // pattern as ArmorBelt.tsx).
    const hovered = ref<VehicleEntry | null>(null);
    const tipPos = ref({ x: 0, y: 0 });

    function onEnter(e: MouseEvent, v: VehicleEntry) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      tipPos.value = { x: r.left + r.width / 2, y: r.top };
      hovered.value = v;
      emit("hoverPlayer", v.name);
    }
    function onLeave() {
      hovered.value = null;
    }

    return () => (
      <div class={["roster-col", `roster-col--${props.kind}`]}>
        <div class="roster-col__head">
          {props.title}
          <span class="roster-col__count">{props.rows.length}</span>
          {props.totalHp > 0 ? (
            <span class="roster-col__totalhp">
              {formatHp(props.totalHp)} HP
            </span>
          ) : null}
        </div>
        <ul class="roster-col__list">
          {props.rows.map((v, idx) => {
            const hp = props.shipHp(v);
            const hpPct = Math.round((hp / props.maxHp) * 100);
            return (
              <li
                class="roster-col__row"
                key={`${v.id}-${v.name}-${idx}`}
                onMouseenter={(e) => onEnter(e, v)}
                onMouseleave={onLeave}
              >
                <div class="roster-col__main">
                  <span class="roster-col__name">{v.name || `#${v.id}`}</span>
                  <span class="roster-col__ship">
                    <span class="roster-col__shiptype">{props.shipTypeShort(v)}</span>
                    {props.shipDisplayName(v)}
                  </span>
                </div>
                <div class="roster-col__hp" title={`${hp.toLocaleString()} HP`}>
                  <div class="roster-col__hp-fill" style={{ width: `${hpPct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
        {hovered.value ? (
          <RosterTooltip
            vehicle={hovered.value}
            pos={tipPos.value}
            shipDisplayName={props.shipDisplayName}
            statsCache={props.statsCache}
            loadingNames={props.loadingNames}
            failedNames={props.failedNames}
          />
        ) : null}
      </div>
    );
  },
});

/** Compact hover tooltip showing a player's WG stats in a 2-column grid.
 *  Anchored via position:fixed above the hovered row (pointer-events:none so
 *  the tooltip never steals focus). Shows a spinner while the lookup is in
 *  flight, then the stats grid once cached. */
const RosterTooltip = defineComponent({
  name: "RosterTooltip",
  props: {
    vehicle: { type: Object as () => VehicleEntry, required: true },
    pos: { type: Object as () => { x: number; y: number }, required: true },
    shipDisplayName: { type: Function as unknown as () => (v: VehicleEntry) => string, required: true },
    statsCache: { type: Object as () => Map<string, PlayerStats>, required: true },
    loadingNames: { type: Object as () => Set<string>, required: true },
    failedNames: { type: Object as () => Set<string>, required: true },
  },
  setup(props) {
    return () => {
      const v = props.vehicle;
      const s = props.statsCache.get(v.name) ?? null;
      const loading = props.loadingNames.has(v.name);
      const failed = props.failedNames.has(v.name);

      const kpis: Array<{ label: string; val: string; color?: string }> = [];
      if (s) {
        kpis.push(
          { label: t("replay.tip.winrate"), val: s.winrate != null ? `${s.winrate.toFixed(1)}%` : "—", color: winrateColor(s.winrate) },
          { label: t("replay.tip.avgDamage"), val: s.avgDamage != null ? Math.round(s.avgDamage).toLocaleString() : "—" },
          { label: t("replay.tip.battles"), val: (s.battles ?? 0).toLocaleString() },
          { label: "PR", val: s.pr != null ? String(Math.round(s.pr)) : "—", color: winrateColor((s.pr ?? 0) / 30) },
          { label: t("replay.tip.survival"), val: s.survivalRate != null ? `${s.survivalRate.toFixed(0)}%` : "—" },
          { label: t("replay.tip.hitRate"), val: s.hitRate != null ? `${s.hitRate.toFixed(0)}%` : "—" },
        );
      }

      return (
        <div
          class="roster-tip"
          style={{ left: `${props.pos.x}px`, top: `${props.pos.y}px` }}
        >
          <div class="roster-tip__name">{v.name || `#${v.id}`}</div>
          {s?.hidden ? (
            <div class="roster-tip__hidden">{t("replay.tip.hidden")}</div>
          ) : loading ? (
            <div class="roster-tip__loading">
              <SSpinner size="sm" /> {t("replay.tip.loading")}
            </div>
          ) : failed ? (
            <div class="roster-tip__hidden">{t("replay.tip.failed")}</div>
          ) : s ? (
            <div class="roster-tip__grid">
              {kpis.map((k) => (
                <div class="roster-tip__kpi" key={k.label}>
                  <span class="roster-tip__kpi-label">{k.label}</span>
                  <span class="roster-tip__kpi-val" style={k.color ? { color: k.color } : undefined}>
                    {k.val}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div class="roster-tip__loading">{t("replay.tip.loading")}</div>
          )}
        </div>
      );
    };
  },
});
