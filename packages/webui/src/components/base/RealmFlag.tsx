import { defineComponent } from "vue";

import type { GameInstallKind } from "@/api";
import "./RealmFlag.scss";

/**
 * WG account realm badge — a small circular flag for the five server
 * realms (ru / eu / na / asia / cn), drawn as inline SVG so no binary
 * assets are needed (game faction crests from `/images/nations*` are a
 * different thing entirely). Unknown realms fall back to a letter disc,
 * mirroring <NationFlag>'s fallback. When the realm is unknown the client
 * kind still implies it for the regional-only installers (Lesta → RU,
 * 360/空中网 → CN).
 *
 * Used by the settings 游戏路径 install list; sized like the account
 * card's PlayerBadge so the two lists read as siblings.
 */

/** One five-pointed star polygon as an SVG points string. */
function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 10; k++) {
    const rad = (Math.PI / 5) * k - Math.PI / 2;
    const rr = k % 2 === 0 ? r : r * 0.4;
    pts.push(`${(cx + rr * Math.cos(rad)).toFixed(2)},${(cy + rr * Math.sin(rad)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** 12 gold stars in a ring — the EU circle at badge scale. */
function euStars(): unknown[] {
  const out: unknown[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (Math.PI / 6) * k;
    out.push(
      <circle
        cx={30 + 11 * Math.cos(a)}
        cy={20 + 11 * Math.sin(a)}
        r={1.6}
        fill="#ffcc00"
      />,
    );
  }
  return out;
}

const FLAGS: Record<string, () => unknown> = {
  ru: () => (
    <svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice">
      <rect width="60" height="40" fill="#ffffff" />
      <rect y="13.33" width="60" height="13.34" fill="#0039a6" />
      <rect y="26.67" width="60" height="13.33" fill="#d52b1e" />
    </svg>
  ),
  eu: () => (
    <svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice">
      <rect width="60" height="40" fill="#003399" />
      {euStars()}
    </svg>
  ),
  na: () => (
    <svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice">
      <rect width="60" height="40" fill="#ffffff" />
      {[0, 2, 4, 6, 8, 10, 12].map((i) => (
        <rect y={(i * 40) / 13} width="60" height={40 / 13} fill="#b22234" />
      ))}
      <rect width="28" height={40 / 13 * 7} fill="#3c3b6e" />
      {[
        [6, 5],
        [14, 5],
        [22, 5],
        [10, 10],
        [18, 10],
        [6, 15],
        [14, 15],
        [22, 15],
      ].map(([x, y]) => (
        <circle cx={x} cy={y} r={1.3} fill="#ffffff" />
      ))}
    </svg>
  ),
  asia: () => (
    <svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice">
      <rect width="60" height="20" fill="#ed2939" />
      <rect y="20" width="60" height="20" fill="#ffffff" />
      <circle cx="16" cy="10" r="7" fill="#ffffff" />
      <circle cx="19" cy="10" r="6" fill="#ed2939" />
      <polygon points={starPoints(26, 7, 2.2)} fill="#ffffff" />
      <polygon points={starPoints(29.5, 10, 2.2)} fill="#ffffff" />
      <polygon points={starPoints(26, 13, 2.2)} fill="#ffffff" />
    </svg>
  ),
  cn: () => (
    <svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice">
      <rect width="60" height="40" fill="#de2910" />
      <polygon points={starPoints(13, 12, 7)} fill="#ffde00" />
      <polygon points={starPoints(25, 5, 2.4)} fill="#ffde00" />
      <polygon points={starPoints(29, 10, 2.4)} fill="#ffde00" />
      <polygon points={starPoints(29, 16, 2.4)} fill="#ffde00" />
      <polygon points={starPoints(25, 21, 2.4)} fill="#ffde00" />
    </svg>
  ),
};

/** Resolve a realm/kind pair to a flag key; null → letter fallback. */
export function realmFlagKey(
  realm: string | null | undefined,
  kind?: GameInstallKind | null,
): string | null {
  const r = realm?.trim().toLowerCase();
  if (r) {
    if (r in FLAGS) return r;
    // Lesta's CIS-region alias.
    if (r === "cis") return "ru";
    return null;
  }
  // Regional-only installers imply their server without a realm string.
  if (kind === "lesta") return "ru";
  if (kind === "cn360" || kind === "cnKongzhong") return "cn";
  return null;
}

export default defineComponent({
  name: "RealmFlag",
  props: {
    realm: { type: String as () => string | null | undefined, default: null },
    kind: { type: String as () => GameInstallKind | null | undefined, default: undefined },
    size: { type: Number, default: 38 },
  },
  setup(props) {
    return () => {
      const key = realmFlagKey(props.realm, props.kind);
      const flag = key ? FLAGS[key]?.() : null;
      const label = (props.realm ?? key ?? "?").toUpperCase();
      return (
        <span
          class="realm-flag"
          style={{ width: `${props.size}px`, height: `${props.size}px` }}
          role="img"
          aria-label={label}
        >
          {flag ?? (
            <span class="realm-flag__fallback">
              {props.realm ? props.realm.slice(0, 2).toUpperCase() : "?"}
            </span>
          )}
        </span>
      );
    };
  },
});
