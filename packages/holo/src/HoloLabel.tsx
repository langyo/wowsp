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
  hp?: number | null;
  maxHp?: number | null;
  dead?: boolean;
  /** Ghost (unseen/sunk) state: dashed border + countdown instead of HP. */
  ghostText?: string | null;
  visible?: boolean;
  selected?: boolean;
  /** OSD auto-contrast ink tone (the host samples the rendered backdrop
   *  under the label and flips this). Undefined → theme-driven ink. */
  tone?: "light" | "dark" | null;
}

const ROLE_BAR: Record<HoloLabelData["role"], string> = {
  self: "#4ade80",
  ally: "#3cb478",
  enemy: "#cc3333",
};

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
  },
  setup(props) {
    // Hide-until-loaded (and stay hidden on error): a failed HUD icon must
    // not surface the browser's broken-image glyph in the label strip.
    const icon = useImage(() => props.label.iconUrl ?? null);
    return () => {
      const l = props.label;
      const pct =
        l.hp != null && l.maxHp != null
          ? Math.max(0, Math.min(100, (l.hp / l.maxHp) * 100))
          : 0;
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
            left: `${l.x}px`,
            top: `${l.y}px`,
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
          {l.hp != null && !l.ghostText && !l.dead ? (
            <span class="holo-label__hp">
              {l.maxHp != null ? (
                <span class="holo-label__hp-bar">
                  <span
                    class="holo-label__hp-fill"
                    style={{ width: `${pct}%`, background: ROLE_BAR[l.role] }}
                  />
                  <span class="holo-label__hp-text">
                    {Math.round(l.hp).toLocaleString()}
                    {l.maxHp != null ? ` / ${Math.round(l.maxHp).toLocaleString()}` : ""}
                  </span>
                </span>
              ) : null}
            </span>
          ) : l.ghostText ? (
            <span class="holo-label__ghost-time">{l.ghostText}</span>
          ) : null}
          {l.dead ? <span class="holo-label__dead-tag">{props.deadText}</span> : null}
        </div>
      );
    };
  },
});
