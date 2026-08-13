/**
 * HoloLabel — floating ship label shared by the app's holographic replay and
 * the marketing site's live sandbox. Extracted verbatim from the app's
 * holo-map overlay: nickname, ship icon + tier + ship name, HP bar (dead /
 * ghost states included). The host supplies the icon URL (game HUD art) and
 * any localised strings; this component is pure rendering + styling.
 */
import { defineComponent, type PropType } from "vue";
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
}

const ROLE_BAR: Record<HoloLabelData["role"], string> = {
  self: "#4ade80",
  ally: "#3cb478",
  enemy: "#cc3333",
};

export default defineComponent({
  name: "HoloLabel",
  props: {
    label: { type: Object as PropType<HoloLabelData>, required: true },
    deadText: { type: String, default: "SUNK" },
  },
  setup(props) {
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
          style={{ left: `${l.x}px`, top: `${l.y}px` }}
        >
          <span class="holo-label__name" title={l.name}>{l.name}</span>
          {l.shipName ? (
            <span class="holo-label__ship">
              {l.iconUrl ? (
                <img class="holo-label__icon" src={l.iconUrl} width={11} height={11} alt="" draggable={false} />
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
                    {l.hp.toLocaleString()}
                    {l.maxHp != null ? ` / ${l.maxHp.toLocaleString()}` : ""}
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
