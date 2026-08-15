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
  /** URL of the game's own hull silhouette bitmap (ships_silhouettes PNG).
   *  Preferred over the vector path — this is the exact in-game HP plaque
   *  art, with its native antialiased edges. */
  silhouetteUrl?: string | null;
  /** Real hull silhouette path (from silhouettes.json), bow pointing right.
   *  Vector fallback used when the bitmap URL is unavailable. */
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

/** Hull silhouettes per class, bow pointing RIGHT. Paths are 0..100 × 0..36.
 *  Solid hulls with visible freeboard and superstructure so the fallback
 *  plaque still reads as a ship (the old art was a near-zero-height sliver
 *  that rendered as a flat line). */
const SILHOUETTES: Record<string, string> = {
  Battleship:
    "M2 30 L20 31 L96 31 L98 30 L98 15 L93 12 L86 14 L84 12 L84 8 L78 8 L78 13 L72 14 L70 13 L70 5 L66 5 L66 14 L60 15 L58 14 L58 4 L48 4 L48 15 L42 15 L40 15 L40 7 L34 7 L34 15 L26 16 L24 15 L24 11 L18 11 L18 16 L10 19 L4 23 Z",
  Cruiser:
    "M2 29 L94 30 L98 28 L98 17 L93 13 L87 15 L85 14 L85 7 L79 7 L79 15 L73 16 L71 15 L71 5 L62 5 L62 16 L56 16 L54 16 L54 9 L48 9 L48 16 L36 17 L33 16 L33 11 L27 11 L27 17 L16 18 L8 21 L3 24 Z",
  Destroyer:
    "M2 27 L94 28 L98 26 L98 19 L93 16 L88 18 L86 17 L86 11 L80 11 L80 17 L74 17 L74 13 L68 13 L68 17 L48 18 L42 17 L42 13 L36 13 L36 18 L18 20 L8 22 L3 24 Z",
  AirCarrier:
    "M2 30 L90 30 L98 28 L98 19 L92 16 L80 17 L74 16 L74 5 L64 5 L64 17 L48 17 L26 18 L8 20 L2 22 Z",
  Submarine:
    "M2 22 L40 24 L88 23 L98 18 L98 15 L92 11 L78 12 L62 12 L62 5 L54 5 L54 13 L40 14 L12 17 L2 19 Z",
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
      const pngUrl = d.silhouetteUrl ?? null;
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
          {pngUrl ? (
            <div
              class="holo-ship-card__hull-png"
              style={{ "--holo-sil": `url("${pngUrl}")` } as Record<string, string>}
              aria-hidden="true"
            >
              <div class="holo-ship-card__sil holo-ship-card__sil-base" />
              {rep > 0 ? (
                <div
                  class="holo-ship-card__sil holo-ship-card__sil-rep"
                  style={{ clipPath: `inset(0 ${Math.max(0, 100 - hpPct - repPct)}% 0 ${hpPct}%)` }}
                />
              ) : null}
              <div
                class="holo-ship-card__sil holo-ship-card__sil-fill"
                style={{
                  clipPath: `inset(0 ${100 - hpPct}% 0 0)`,
                  color: healthColor(hpPct),
                }}
              />
            </div>
          ) : (
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
          )}
        </div>
      );
    };
  },
});
