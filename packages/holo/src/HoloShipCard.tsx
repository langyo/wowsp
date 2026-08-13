/**
 * HoloShipCard — the recorder/self ship's health plaque (app + site).
 *
 * The hull silhouette *is* the health bar: a dim "empty" hull outline is
 * always visible, and a coloured fill is clipped to the current HP fraction
 * (filling left→right, green → amber → red), plus a grey "repairable" segment
 * on the right for the pool a repair party could still recover. The host
 * supplies hp/maxHp and an optional repairable pool (the site approximates it
 * from the damage taken; the app can pass real values when the replay
 * provides them).
 */
import { defineComponent, type PropType } from "vue";
import "./HoloShipCard.scss";

export interface HoloShipCardData {
  /** WG ship type — drives the hull silhouette fallback. */
  shipType?: string;
  /** Real hull silhouette path (from silhouettes.json), bow pointing right. */
  silhouette?: string | null;
  /** Display name (localised ship name + nickname). */
  name?: string;
  hp: number | null;
  maxHp: number | null;
  /** Remaining repairable pool (grey segment), in HP. */
  repairableHp?: number | null;
  /** True once the ship is sunk. */
  dead?: boolean;
}

/** Hull silhouettes per class, bow pointing RIGHT. Paths are 0..100 × 0..36. */
const SILHOUETTES: Record<string, string> = {
  Battleship:
    "M2 30 L8 26 L14 24 L22 23 L30 22 L46 20 L58 19 L66 16 L78 12 L84 10 L98 8 L98 6 L90 10 L80 13 L70 15 L62 17 L52 18 L40 20 L30 21 L22 23 L16 26 L10 29 Z",
  Cruiser:
    "M2 28 L10 25 L18 23 L28 22 L40 21 L52 19 L64 16 L76 12 L86 9 L98 7 L98 5 L88 9 L78 12 L66 16 L54 19 L42 21 L30 22 L20 24 L12 27 Z",
  Destroyer:
    "M2 24 L12 21 L24 19 L38 17 L52 14 L66 11 L78 9 L90 7 L98 5 L98 4 L88 7 L76 9 L64 11 L50 14 L36 17 L22 19 L12 22 Z",
  AirCarrier:
    "M4 32 L14 30 L26 28 L38 24 L52 20 L64 14 L76 11 L88 9 L98 7 L98 5 L86 9 L74 12 L62 16 L50 20 L38 24 L26 28 L14 31 Z",
  Submarine:
    "M2 20 L14 16 L28 13 L42 11 L56 10 L70 10 L82 12 L94 15 L98 16 L98 14 L82 11 L70 9 L56 8 L42 9 L28 11 L14 15 Z",
};

function silhouetteOf(type?: string): string {
  if (!type) return SILHOUETTES.Battleship;
  for (const [key, path] of Object.entries(SILHOUETTES)) {
    if (type.toLowerCase().includes(key.toLowerCase())) return path;
  }
  return SILHOUETTES.Battleship;
}

function healthColor(pct: number): string {
  if (pct > 60) return "#4ade80"; // green
  if (pct > 30) return "#facc15"; // amber
  return "#f87171"; // red
}

/** Unique clip-path ids for the fill segments (stable per component instance). */
let cardUid = 0;

export default defineComponent({
  name: "HoloShipCard",
  props: {
    data: { type: Object as PropType<HoloShipCardData>, required: true },
  },
  setup(props) {
    const uid = `holo-ship-card-${++cardUid}`;
    return () => {
      const d = props.data;
      const max = d.maxHp ?? d.hp ?? 0;
      const hp = d.hp ?? 0;
      const rep = d.repairableHp ?? 0;
      const total = Math.max(1, max + rep);
      const hpPct = Math.max(0, Math.min(100, (hp / total) * 100));
      const repPct = Math.max(0, Math.min(100 - hpPct, (rep / total) * 100));
      const path = d.silhouette ?? silhouetteOf(d.shipType);
      const showText = d.hp != null && d.maxHp != null;
      return (
        <div class={["holo-ship-card", d.dead ? "holo-ship-card--dead" : ""].join(" ")}>
          {d.name || showText ? (
            <div class="holo-ship-card__head">
              {d.name ? <span class="holo-ship-card__name">{d.name}</span> : null}
              {showText ? (
                <span class="holo-ship-card__text">
                  {d.dead ? "—" : `${d.hp!.toLocaleString()} / ${d.maxHp!.toLocaleString()}`}
                </span>
              ) : null}
            </div>
          ) : null}
          <svg
            class="holo-ship-card__hull"
            viewBox="0 0 100 36"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <clipPath id={`${uid}-hp`}>
                <rect x="0" y="0" width={hpPct} height="36" />
              </clipPath>
              {rep > 0 ? (
                <clipPath id={`${uid}-rep`}>
                  <rect x={hpPct} y="0" width={repPct} height="36" />
                </clipPath>
              ) : null}
            </defs>
            <path d={path} class="holo-ship-card__hull-base" />
            {rep > 0 ? (
              <path
                d={path}
                class="holo-ship-card__hull-rep"
                style={{ clipPath: `url(#${uid}-rep)` }}
              />
            ) : null}
            <path
              d={path}
              class="holo-ship-card__hull-fill"
              style={{
                clipPath: `url(#${uid}-hp)`,
                color: healthColor(hpPct),
              }}
            />
          </svg>
        </div>
      );
    };
  },
});
