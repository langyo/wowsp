/**
 * In-game stat chips (Mode 2 / M8). Renders one colored chip per player row —
 * winrate % + average damage — anchored to the team-list position detected by
 * the Rust Tab watcher (`wowsp://overlay-anchor`).
 *
 * Anchoring contract: the overlay window exactly covers the game window, and
 * the anchor's coordinates are PHYSICAL pixels relative to that window's
 * top-left corner. CSS pixels = physical / devicePixelRatio (the WebView2
 * per-monitor DPI matches the monitor the window sits on, so the math holds
 * on multi-monitor setups with mixed scaling).
 *
 * Row↔player mapping assumes the game's Tab table lists each team in
 * `tempArenaInfo.json` order (the convention community stat overlays rely
 * on). `rowCenters` arrives header-trimmed and capped to the roster size, so
 * allies map to the left column top-down and enemies to the right column.
 */
import { onBeforeUnmount, onMounted, ref, defineComponent, type CSSProperties } from "vue";

import type { VehicleEntry } from "@/api";
import { useRosterStats, isAiName } from "@/composables/useRosterStats";
import { useOverlayStore } from "@/stores/overlay";
import { damageColor, winrateColor } from "@/utils/winrate";
import { t } from "@/i18n";
import "./OverlayStatsLayer.scss";

function formatAvgDamage(avg: number): string {
  return avg >= 100000 ? `${Math.round(avg / 1000)}k` : `${(avg / 1000).toFixed(1)}k`;
}

export default defineComponent({
  name: "OverlayStatsLayer",
  setup() {
    const store = useOverlayStore();
    const { stats } = useRosterStats({
      realm: () => store.realm,
      arena: () => store.arenaInfo,
    });

    // The Rust side resizes the overlay window per anchor; track the CSS
    // size reactively so chip offsets recompute if a render lands before
    // (or after) the native resize.
    const winSize = ref({ w: window.innerWidth, dpr: window.devicePixelRatio || 1 });
    const onResize = () => {
      winSize.value = { w: window.innerWidth, dpr: window.devicePixelRatio || 1 };
    };
    onMounted(() => window.addEventListener("resize", onResize));
    onBeforeUnmount(() => window.removeEventListener("resize", onResize));

    return () => {
      const anchor = store.anchor;
      if (!anchor || !store.arenaInfo || anchor.rowCenters.length === 0) return null;

      const dpr = winSize.value.dpr;
      const rows = anchor.rowCenters;
      const rr = anchor.rosterRect;
      const winW = winSize.value.w;
      const pitchCss =
        rows.length >= 2 ? Math.abs(rows[1] - rows[0]) / dpr : 24;
      const fontSize = Math.min(15, Math.max(9, pitchCss * 0.42));
      const insetPhys = Math.max(6, Math.round(pitchCss * 0.12 * dpr));
      const splitX = rr.x + rr.width * anchor.teamSplit;
      const alliesRightCss = (splitX - insetPhys) / dpr;
      const enemiesLeftCss = (splitX + insetPhys) / dpr;

      const chip = (v: VehicleEntry, side: "ally" | "enemy", yPhys: number) => {
        const style: CSSProperties = {
          top: `${yPhys / dpr}px`,
          transform: "translateY(-50%)",
          fontSize: `${fontSize.toFixed(1)}px`,
        };
        if (side === "ally") {
          style.right = `${Math.max(0, winW - alliesRightCss)}px`;
        } else {
          style.left = `${enemiesLeftCss}px`;
        }

        let content;
        if (isAiName(v.name)) {
          content = <span class="overlay-chip__muted">{t("replay.bot")}</span>;
        } else {
          const st = stats.get(v.id);
          if (!st || st.loading) {
            content = <span class="overlay-chip__muted">…</span>;
          } else if (st.hidden) {
            content = (
              <span class="overlay-chip__hidden">{t("replay.live.hiddenProfile")}</span>
            );
          } else if (st.winrate != null) {
            content = (
              <>
                <b style={{ color: winrateColor(st.winrate) }}>
                  {st.winrate.toFixed(1)}%
                </b>
                <span class="overlay-chip__sep">·</span>
                <b style={{ color: damageColor(st.avgDamage) }}>
                  {st.avgDamage != null ? formatAvgDamage(st.avgDamage) : "—"}
                </b>
              </>
            );
          } else {
            content = <span class="overlay-chip__muted">—</span>;
          }
        }

        return (
          <div class={`overlay-chip overlay-chip--${side}`} key={`${side}-${v.id}`} style={style}>
            {content}
          </div>
        );
      };

      const allyChips = store.allies.map((v, i) =>
        rows[i] != null ? chip(v, "ally", rows[i]) : null,
      );
      const enemyChips = store.enemies.map((v, i) =>
        rows[i] != null ? chip(v, "enemy", rows[i]) : null,
      );

      return <div class="overlay-stats-layer">{[...allyChips, ...enemyChips]}</div>;
    };
  },
});
