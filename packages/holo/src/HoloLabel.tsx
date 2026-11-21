/**
 * HoloLabel — floating ship label shared by the app's holographic replay and
 * the marketing site's live sandbox. Extracted verbatim from the app's
 * holo-map overlay: nickname, ship icon + tier + ship name, HP bar (dead /
 * ghost states included). The host supplies the icon URL (game HUD art) and
 * any localised strings; this component is pure rendering + styling.
 */
import { defineComponent, type PropType } from "vue";
import { useImage } from "./composables/useImage";
import { tierToRoman } from "./tierRoman";
import "./HoloLabel.scss";

export interface HoloLabelData {
  key: string | number;
  x: number;
  y: number;
  role: "self" | "ally" | "enemy";
  name: string;
  shipName?: string;
  tier?: number | null;
  iconUrl?: string | null;
  /** Planes still flying in this aircraft label's squadron (E27 planesHealth
   *  digit count). Rendered after the aircraft type next to the label's HP
   *  bar; null/undefined on pre-E27 replays (the count is simply omitted). */
  planeAlive?: number | null;
  hp?: number | null;
  maxHp?: number | null;
  /** Repair-Party recoverable pool as a fraction of maxHp (0..1), or null
   *  when the replay carried no repair-party activation for the hull (or the
   *  host does not compute it at all — the marketing sandbox). The HP bar then
   *  splits into its three layers, solid green | light-green | red: the
   *  light-green is the share a repair party can still restore (the QUEUED
   *  heal, painted as a pre-cover of what green will become), red is what is
   *  lost for good. Absent / null renders the historical two-layer bar
   *  unchanged. */
  hpRecoverableFrac?: number | null;
  /** Submerged-submarine depth readout: POSITIVE meters below the surface.
   *  Rendered as a compact tag beside the HP chip (same ~10 Hz content
   *  throttle the host's per-tick label refresh already runs on). Null /
   *  omitted for surface ships and non-submarines — nothing renders. */
  depthMeters?: number | null;
  dead?: boolean;
  /** Ghost (unseen/sunk) state: dashed border + countdown instead of HP. */
  ghostText?: string | null;
  visible?: boolean;
  selected?: boolean;
  /** Local player-marker color (玩家标记): a colored bead at the ship
   *  icon's bottom-right corner. Optional and default-off — hosts that
   *  never set it (the marketing sandbox) render exactly as before. */
  markerColor?: "red" | "yellow" | "purple" | null;
  /** OSD auto-contrast ink tone (the host samples the rendered backdrop
   *  under the label and flips this). Undefined → theme-driven ink. */
  tone?: "light" | "dark" | null;
  /** Extra thin bars UNDER the HP bar (aircraft: engine boost + the one-shot
   *  temporary boost window). A plane can run both at once, so this is a
   *  list instead of one value; `frac` 0..1, clamped on render. Hosts that
   *  never set it (marketing sandbox, ship labels) render exactly as before. */
  extraBars?: { key: string; color: string; frac: number }[];
}

const ROLE_BAR: Record<HoloLabelData["role"], string> = {
  self: "#4ade80",
  ally: "#3cb478",
  enemy: "#cc3333",
};

/** Overlap between the solid green HP fill and the queued (recoverable)
 *  light-green layer, in CSS pixels: the queued layer starts this far LEFT of
 *  the green's right edge, under the green's rounded corner, so the two never
 *  show a seam gap. Exported for the geometry tests. */
export const HP_QUEUE_SEAM_PX = 2;

/** Ink palettes for the OSD auto-contrast tone (see the app's
 *  osdContrast.ts): "light" = white ink over a dark backdrop (the
 *  historical look), "dark" = grey-800 ink over a bright one. Applied as
 *  inline CSS custom properties — they override both the default (dark
 *  theme) rules and the `:root[data-mode="light"]` flip, so a tone pin
 *  wins regardless of theme while `tone: undefined` keeps the historical
 *  theme-driven behavior untouched. */
const TONE_INK_VARS: Record<NonNullable<HoloLabelData["tone"]>, Record<string, string>> = {
  light: {
    "--label-ink": "rgba(255, 255, 255, 0.92)",
    "--label-ink-name": "rgba(255, 255, 255, 0.95)",
    "--label-ink-ship": "rgba(255, 255, 255, 0.7)",
    "--label-ink-tier": "rgba(100, 200, 255, 0.85)",
    "--label-ink-hp": "rgba(100, 255, 150, 0.9)",
    "--label-ink-hp-bar-bg": "rgba(5, 8, 15, 0.55)",
    "--label-ink-hp-recover": "rgb(170 235 180 / 60%)",
    "--label-ink-hp-lost": "rgb(248 92 92 / 45%)",
    "--label-ink-hp-text": "#ffffff",
    "--label-ink-hp-text-shadow": "0 0 2px rgba(0, 0, 0, 0.9)",
    "--label-ink-ghost-bg": "rgba(5, 8, 15, 0.55)",
    "--label-ink-ghost": "rgba(255, 255, 255, 0.75)",
  },
  dark: {
    "--label-ink": "rgb(55 65 81 / 92%)",
    "--label-ink-name": "rgb(55 65 81 / 96%)",
    "--label-ink-ship": "rgb(55 65 81 / 72%)",
    "--label-ink-tier": "rgb(23 100 170 / 95%)",
    "--label-ink-hp": "rgb(20 130 80 / 95%)",
    "--label-ink-hp-bar-bg": "rgb(55 65 81 / 10%)",
    "--label-ink-hp-recover": "rgb(96 174 112 / 65%)",
    "--label-ink-hp-lost": "rgb(220 80 80 / 45%)",
    "--label-ink-hp-text": "#374151",
    "--label-ink-hp-text-shadow": "0 0 2px rgb(255 255 255 / 80%)",
    "--label-ink-ghost-bg": "rgb(255 255 255 / 55%)",
    "--label-ink-ghost": "rgb(55 65 81 / 78%)",
  },
};

export default defineComponent({
  name: "HoloLabel",
  props: {
    label: { type: Object as PropType<HoloLabelData>, required: true },
    deadText: { type: String, default: "SUNK" },
    /** Host-managed positioning: the app wraps this label in a slot div the
     *  render loop translates imperatively, so the label pins itself to the
     *  slot's origin instead of writing its own left/top (which would fight
     *  the wrapper and re-run style/layout per frame). Default false keeps
     *  the historical self-positioning for hosts like the marketing site. */
    hostPositioned: { type: Boolean, default: false },
  },
  setup(props) {
    // Hide-until-loaded (and stay hidden on error): a failed HUD icon must
    // not surface the browser's broken-image glyph in the label strip.
    const icon = useImage(() => props.label.iconUrl ?? null);
    return () => {
      const l = props.label;
      // A sunk ship stays at 0 HP from its death on — the chip keeps the
      // full "0 / max" shape instead of collapsing into the dead tag, even
      // when the HP stream never witnessed the killing blow.
      const shownHp = l.dead ? 0 : (l.hp ?? 0);
      const pct =
        !l.dead && l.hp != null && l.maxHp != null
          ? Math.max(0, Math.min(100, (l.hp / l.maxHp) * 100))
          : 0;
      // Three-layer bar (the game's own repair reading): solid green (current
      // HP) | light green (the repair pool that can still restore lost HP —
      // the QUEUED heal, not a dead grey rail) | red (lost for good). The
      // light-green takes its width OUT OF the red remainder — never out of
      // green. Only rendered when the host supplies a pool, so a host that
      // never sets hpRecoverableFrac (the marketing sandbox, or a replay with
      // no repair party stream) keeps the exact historical bar.
      // Same clamp as the app's pure repairPool.hpBarSegments — this package
      // cannot import from the webui.
      const repFrac =
        !l.dead && !l.ghostText && l.hpRecoverableFrac != null
          ? Math.max(0, Math.min(1, l.hpRecoverableFrac))
          : null;
      const queuedPct = repFrac == null ? 0 : Math.min(repFrac * 100, 100 - pct);
      const lostPct = 100 - pct - queuedPct;
      // Seam rule (user report: "灰血范围其实做的不太好"): the queued layer
      // starts just LEFT of the green layer's right edge so the two overlap
      // instead of abutting. The green paints ON TOP (its own z-index) and
      // keeps its rounded right corner, so the 2 px sliver underneath closes
      // the corner notches instead of showing a hairline gap; the queued
      // layer's own left edge is square. Zero queue → no overlap at all.
      const seamPx = queuedPct > 0 ? HP_QUEUE_SEAM_PX : 0;
      const queuedLeft = seamPx > 0 ? `calc(${pct}% - ${seamPx}px)` : `${pct}%`;
      const queuedWidth = seamPx > 0 ? `calc(${queuedPct}% + ${seamPx}px)` : `${queuedPct}%`;
      return (
        <div
          class={[
            "holo-label",
            `holo-label--${l.role}`,
            l.dead ? "holo-label--dead" : "",
            l.ghostText ? "holo-label--ghost" : "",
            l.visible === false ? "holo-label--hidden" : "",
            l.selected ? "holo-label--selected" : "",
          ].join(" ")}
          style={{
            left: props.hostPositioned ? "0px" : `${l.x}px`,
            top: props.hostPositioned ? "0px" : `${l.y}px`,
            // Ink override only when the OSD sampler has spoken; otherwise
            // the stylesheet's theme-driven palette applies untouched.
            ...(l.tone ? TONE_INK_VARS[l.tone] : null),
          }}
        >
          {/* Empty name (scripted scenario NPCs sail under their ship name
              only) renders nothing — not a blank flex row. */}
          {l.name ? (
            <span class="holo-label__name" title={l.name}>{l.name}</span>
          ) : null}
          {l.shipName ? (
            <span class="holo-label__ship">
              {l.markerColor ? (
                <span class={["holo-label__marker", `holo-label__marker--${l.markerColor}`].join(" ")} />
              ) : null}
              {icon.src.value ? (
                <img
                  class="holo-label__icon"
                  src={icon.src.value}
                  width={11}
                  height={11}
                  alt=""
                  draggable={false}
                  style={{ visibility: icon.status.value === "loaded" ? "visible" : "hidden" }}
                  onLoad={icon.onLoad}
                  onError={icon.onError}
                />
              ) : null}
              {l.tier != null ? <span class="holo-label__tier">{tierToRoman(l.tier)}</span> : null}
              {l.shipName}
            </span>
          ) : null}
          {l.hp != null && !l.ghostText ? (
            <span class="holo-label__hp">
              {l.maxHp != null ? (
                <span class="holo-label__hp-bar">
                  {/* Repair layers paint UNDER the green fill: red is the
                      permanent loss (right end, square at the junction), the
                      light green the queued repair pool sitting between green
                      and red — its left edge tucked 2 px under the green's
                      rounded right corner (see the seam rule above). */}
                  {repFrac != null ? (
                    <span
                      class="holo-label__hp-lost"
                      style={{ left: `${pct + queuedPct}%`, width: `${lostPct}%` }}
                    />
                  ) : null}
                  {repFrac != null ? (
                    <span
                      class="holo-label__hp-recover"
                      style={{ left: queuedLeft, width: queuedWidth }}
                    />
                  ) : null}
                  <span
                    class="holo-label__hp-fill"
                    style={{ width: `${pct}%`, background: ROLE_BAR[l.role] }}
                  />
                  <span class="holo-label__hp-text">
                    {l.planeAlive != null
                      ? `${Math.round(pct)}% · ✈${l.planeAlive}`
                      : `${Math.round(shownHp).toLocaleString()}${
                          l.maxHp != null ? ` / ${Math.round(l.maxHp).toLocaleString()}` : ""
                        }`}
                  </span>
                </span>
              ) : null}
              {/* Submerged submarine: compact depth tag beside the HP chip.
                  Positive meters below surface; a host that never sets
                  depthMeters (the marketing sandbox) renders exactly as
                  before. Rides the same content throttle as the HP numbers. */}
              {l.depthMeters != null ? (
                <span class="holo-label__depth">
                  <span class="holo-label__depth-arrow" aria-hidden="true" />
                  {`${l.depthMeters} m`}
                </span>
              ) : null}
            </span>
          ) : l.ghostText ? (
            <span class="holo-label__ghost-time">{l.ghostText}</span>
          ) : null}
          {l.extraBars?.length ? (
            <span class="holo-label__bars">
              {l.extraBars.map((b) => (
                <span class="holo-label__bar" key={b.key}>
                  <span
                    class="holo-label__bar-fill"
                    style={{
                      width: `${Math.max(0, Math.min(1, b.frac)) * 100}%`,
                      background: b.color,
                    }}
                  />
                </span>
              ))}
            </span>
          ) : null}
          {/* Dead tag only when no HP chip is on screen to carry the "0 / max"
              readout (hosts without HP data keep the textual SUNK marker). */}
          {l.dead && (l.hp == null || l.maxHp == null || l.ghostText) ? (
            <span class="holo-label__dead-tag">{props.deadText}</span>
          ) : null}
        </div>
      );
    };
  },
});
