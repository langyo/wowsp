/**
 * Compact, SEMI-TRANSPARENT hover card for one entity on the enlarged 2D
 * minimap (the "2D view" overlay): ships, aircraft squadrons, torpedoes,
 * smoke screens, capture points and fighter-patrol ward rims.
 *
 * The card is Teleported to <body> (the map's stacking/scrim never clips it)
 * and positioned `fixed` 16 root-visual px right/below the cursor, clamped
 * into the viewport with the same measure-then-place policy as
 * HoloShipTooltip (the card is content-sized, so the clamp reads its real
 * rendered box instead of estimating). It is pointer-events:none — it must
 * never steal the hover it describes — and sits one z-band above the 2D
 * overlay, below the Tab roster/modal layers.
 *
 * The glass recipe is deliberately translucent (rgba(6,10,18,0.72) +
 * backdrop blur): the map art stays visible through the card, so the hover
 * reads as an annotation on the map, not a panel on top of it. The team
 * accent stripe/dot is the map's own self-white / ally-green / enemy-red
 * palette. All text goes through i18nT/t(); only the rows that make sense
 * for the hovered kind are built (see describeTarget).
 */
import {
  computed,
  defineComponent,
  onMounted,
  onUpdated,
  ref,
  Teleport,
  type CSSProperties,
  type PropType,
} from "vue";

import { t } from "@/i18n";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import { shipTypeShort } from "@/features/replay/shipLiveStats";
import { M_PER_WORLD_UNIT } from "./weather";
import type { MinimapHoverTarget } from "./minimapPick";
import "./MinimapHoverTip.scss";

/** Gap between the cursor and the card's top-left corner (root-visual px). */
const TIP_OFFSET_PX = 16;
/** Keep-out margin from the viewport edges (root-visual px). */
const TIP_EDGE_PX = 8;

/** Team accent family the card paints (neutral = smoke / ownerless point). */
type TipAccent = "self" | "ally" | "enemy" | "neutral";

/** Team-role i18n keys — the map HUD's shared legend labels. */
const ROLE_KEY: Record<"self" | "ally" | "enemy", string> = {
  self: "replay.legend.self",
  ally: "replay.legend.ally",
  enemy: "replay.legend.enemy",
};

/** Aircraft behavioural family → shared ships.plane.* label. The replay's
 *  PLANE_TYPES families fold HE/AP/torpedo/skip/rocket hardware variants onto
 *  these; unknown families fall back to the raw family string. */
const PLANE_TYPE_KEY: Record<string, string> = {
  fighter: "ships.plane.fighter",
  dive: "ships.plane.heBomber",
  skip: "ships.plane.apSkip",
  torpedo: "ships.plane.torpedo",
  rocket: "ships.plane.rocket",
  bomber: "ships.plane.apBomber",
  scout: "ships.plane.scout",
  attack: "ships.plane.auxiliary",
};

/** One label/value row of the card body. */
interface TipRow {
  label: string;
  value: string;
  /** Dim secondary values (status hints / last-known notes). */
  dim?: boolean;
}

/** Everything the card needs to render one hover target, derived once. */
interface TipView {
  /** Canonical target kind — also the BEM modifier (`--ship`, `--plane`…). */
  kind: MinimapHoverTarget["kind"];
  title: string;
  subtitle: string | null;
  rows: TipRow[];
  accent: TipAccent;
  /** Ship hull bar fill (0..1); null for every other kind. */
  hpPct: number | null;
  /** Team tone of the hull bar. */
  hpRole: "self" | "ally" | "enemy" | null;
  /** Sunk ships dim the accent stripe (they hover as ghosts on the map). */
  dead: boolean;
}

/** World units → kilometres (1 world unit = 30 m — M_PER_WORLD_UNIT, the
 *  same scale the range rings and the weather badge read). */
function kmLabel(radiusWorld: number): string {
  const km = (radiusWorld * M_PER_WORLD_UNIT) / 1000;
  return `${km.toFixed(1)} km`;
}

/** Build the card content for one picked target. Pure, allocation-light and
 *  locale-agnostic apart from the t() lookups. */
function describeTarget(
  target: MinimapHoverTarget,
): TipView {
  switch (target.kind) {
    case "ship": {
      const classCode = shipTypeShort(target.shipType);
      const title = target.shipName || target.label;
      // The subtitle carries the class code only — the player nickname and
      // the ship name have their own rows below (no duplicated identity).
      const subtitleBits: string[] = [];
      if (classCode) subtitleBits.push(classCode);
      const rows: TipRow[] = [];
      if (target.label && target.label !== title) {
        rows.push({ label: t("replay.minimap.tip.player"), value: target.label });
      }
      if (target.shipName && target.shipName !== title) {
        rows.push({ label: t("replay.minimap.tip.ship"), value: target.shipName });
      }
      rows.push({
        label: t("replay.minimap.tip.team"),
        value: t(ROLE_KEY[target.role]),
      });
      // Sunk hulls pin to an empty bar — the stream may not carry the
      // killing blow's zero sample.
      const hp = target.dead ? 0 : target.hp;
      if (hp != null) {
        rows.push({
          label: t("replay.minimap.tip.hp"),
          value:
            target.maxHp != null
              ? `${Math.round(hp).toLocaleString()} / ${Math.round(target.maxHp).toLocaleString()}`
              : Math.round(hp).toLocaleString(),
        });
      }
      if (target.dead) {
        rows.push({
          label: t("replay.minimap.tip.status"),
          value: t("replay.minimap.tip.sunk"),
        });
      } else if (target.unspotted) {
        rows.push({
          label: t("replay.minimap.tip.status"),
          value: t("replay.minimap.tip.lastKnown"),
          dim: true,
        });
      }
      const hpPct =
        hp != null && target.maxHp != null && target.maxHp > 0
          ? Math.max(0, Math.min(1, hp / target.maxHp))
          : null;
      return {
        kind: "ship",
        title,
        subtitle: subtitleBits.length > 0 ? subtitleBits.join(" · ") : null,
        rows,
        accent: target.role,
        hpPct,
        hpRole: target.role,
        dead: target.dead,
      };
    }
    case "plane": {
      const labelKey = PLANE_TYPE_KEY[target.planeType];
      const typeLabel = labelKey ? t(labelKey) : target.planeType;
      const rows: TipRow[] = [
        { label: t("replay.minimap.tip.team"), value: t(ROLE_KEY[target.role]) },
      ];
      // Decoded squadron strength (E27), two rows — 在飞 X / 出击 Y. The
      // 编队 ×GameParams-count row this replaces showed the ATTACK-GROUP
      // size (423/936 plane_types entries are 1), never the flying
      // squadron — the misleading ×1 report. A trail-derived fallback
      // (flying/launched from the live formation members) keeps the rows
      // meaningful on pre-E27 replays; when even that is absent the rows
      // drop out instead of showing a wrong number.
      if (target.flying != null) {
        rows.push({ label: t("replay.minimap.tip.flying"), value: String(target.flying) });
      }
      if (target.launched != null) {
        rows.push({ label: t("replay.minimap.tip.launched"), value: String(target.launched) });
      }
      if (target.hp != null) {
        rows.push({
          label: t("replay.minimap.tip.hp"),
          value: `${Math.round(Math.max(0, Math.min(1, target.hp)) * 100)}%`,
        });
      }
      if (target.carrierLabel) {
        rows.push({
          label: t("replay.minimap.tip.carrier"),
          value: target.carrierLabel,
        });
      }
      return {
        kind: "plane",
        title: t("replay.minimap.tip.plane"),
        subtitle: typeLabel,
        rows,
        accent: target.role,
        hpPct: null,
        hpRole: null,
        dead: false,
      };
    }
    case "torpedo": {
      // The subtitle names the firing ship; the body shows side + timers.
      // A raw entity id (unresolved roster join / a decoder that emitted no
      // player name) is noise, not a name — the side reads better there.
      const owner =
        target.ownerLabel && !/^\d+$/.test(target.ownerLabel.trim())
          ? target.ownerLabel
          : null;
      const rows: TipRow[] = [
        { label: t("replay.minimap.tip.team"), value: t(ROLE_KEY[target.role]) },
      ];
      rows.push({
        label: t("replay.minimap.tip.age"),
        value: `${target.ageS.toFixed(1)} s`,
      });
      rows.push({
        label: t("replay.minimap.tip.remaining"),
        value: `${Math.max(0, Math.ceil(target.remainingS))} s`,
      });
      return {
        kind: "torpedo",
        title: t("replay.minimap.tip.torpedo"),
        subtitle: owner ?? t(ROLE_KEY[target.role]),
        rows,
        accent: target.role,
        hpPct: null,
        hpRole: null,
        dead: false,
      };
    }
    case "smoke":
      return {
        kind: "smoke",
        title: t("replay.minimap.tip.smoke"),
        subtitle: null,
        rows: [
          {
            label: t("replay.minimap.tip.remaining"),
            value: `${Math.max(0, Math.ceil(target.remainingS))} s`,
          },
        ],
        accent: "neutral",
        hpPct: null,
        hpRole: null,
        dead: false,
      };
    case "cap": {
      const ownerLabel =
        target.owner === 1
          ? t("replay.legend.ally")
          : target.owner === 2
            ? t("replay.legend.enemy")
            : t("replay.minimap.tip.neutral");
      const rows: TipRow[] = [
        { label: t("replay.minimap.tip.owner"), value: ownerLabel },
      ];
      const eta = target.etaS;
      if (eta != null && eta > 0) {
        rows.push({
          label: t("replay.minimap.tip.remaining"),
          value: `${Math.ceil(eta)} s`,
        });
      }
      return {
        kind: "cap",
        title: `${t("replay.minimap.tip.cap")} ${target.letter}`,
        // The owner row already names the side; the subtitle only adds the
        // live capture progress note (nothing when the point is idle).
        subtitle:
          eta != null && eta > 0
            ? t("replay.minimap.tip.capturing", { n: Math.ceil(eta) })
            : null,
        rows,
        accent: target.owner === 1 ? "ally" : target.owner === 2 ? "enemy" : "neutral",
        hpPct: null,
        hpRole: null,
        dead: false,
      };
    }
    case "ward":
      return {
        kind: "ward",
        title: t("replay.minimap.tip.ward"),
        subtitle: t(ROLE_KEY[target.role]),
        // The side is the subtitle — the body only needs the patrol
        // geometry and (when resolved) the owning carrier.
        rows: [
          {
            label: t("replay.minimap.tip.radius"),
            value: kmLabel(target.radiusWorld),
          },
          ...(target.ownerLabel
            ? [{ label: t("replay.minimap.tip.owner"), value: target.ownerLabel }]
            : []),
        ],
        accent: target.role,
        hpPct: null,
        hpRole: null,
        dead: false,
      };
  }
}

export default defineComponent({
  name: "MinimapHoverTip",
  props: {
    /** Picked entity under the cursor (see minimapPick.pickMinimapTarget). */
    target: {
      type: Object as PropType<MinimapHoverTarget>,
      required: true,
    },
    /** Cursor position in CLIENT (root-visual) px — the placement anchor. */
    x: { type: Number, required: true },
    y: { type: Number, required: true },
  },
  setup(props) {
    const view = computed(() => describeTarget(props.target));
    // The app's manual interface scale: fixed-position coordinates written
    // from client px live in the root zoom's LOCAL space, so both the cursor
    // anchor and the viewport clamp are divided by it (HoloShipTooltip's
    // placement contract).
    const dpiScale = useAppliedDpiScale();

    const cardEl = ref<HTMLElement | null>(null);
    const pos = ref<CSSProperties>({
      left: "0px",
      top: "0px",
      visibility: "hidden",
    });
    let lastLeft = Number.NaN;
    let lastTop = Number.NaN;

    /** Measure the real card box, place it beside the cursor and clamp it
     *  into the viewport. Re-run on every content update (5 Hz live data
     *  keeps changing the card's size/rows). */
    function place(): void {
      const el = cardEl.value;
      if (!el) return;
      const z = dpiScale.value > 0 ? dpiScale.value : 1;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const viewportW = window.innerWidth / z;
      const viewportH = window.innerHeight / z;
      const left = Math.max(
        TIP_EDGE_PX,
        Math.min(props.x / z + TIP_OFFSET_PX, viewportW - width - TIP_EDGE_PX),
      );
      const top = Math.max(
        TIP_EDGE_PX,
        Math.min(props.y / z + TIP_OFFSET_PX, viewportH - height - TIP_EDGE_PX),
      );
      // Write only on a real move: assigning a fresh object every update
      // would re-render → onUpdated → place → re-render forever.
      if (left === lastLeft && top === lastTop && pos.value.visibility === "visible") {
        return;
      }
      lastLeft = left;
      lastTop = top;
      pos.value = {
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        visibility: "visible",
      };
    }

    onMounted(place);
    onUpdated(place);

    return () => {
      const v = view.value;
      const cls = [
        // The literal "mm-hover-tip" token is the app-level hover-scanner
        // contract (document.querySelector('.mm-hover-tip')); keep it first.
        "mm-hover-tip",
        `mm-hover-tip--${v.accent}`,
        `mm-hover-tip--${v.kind}`,
        v.dead ? "mm-hover-tip--dead" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return (
        <Teleport to="body">
          <div
            ref={cardEl}
            class={cls}
            style={pos.value}
            role="tooltip"
            aria-label={t("replay.minimap.tip.title")}
          >
            <span class="mm-hover-tip__accent" aria-hidden="true" />
            <div class="mm-hover-tip__head">
              <span class="mm-hover-tip__dot" aria-hidden="true" />
              <div class="mm-hover-tip__head-text">
                <span class="mm-hover-tip__title">{v.title}</span>
                {v.subtitle ? (
                  <span class="mm-hover-tip__subtitle">{v.subtitle}</span>
                ) : null}
              </div>
            </div>
            <div class="mm-hover-tip__rows">
              {v.rows.map((row, i) => (
                <div class="mm-hover-tip__row" key={`${row.label}-${i}`}>
                  <span class="mm-hover-tip__row-label">{row.label}</span>
                  <span
                    class={[
                      "mm-hover-tip__row-value",
                      row.dim ? "mm-hover-tip__row-value--dim" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
            {v.hpPct != null && v.hpRole ? (
              <div class="mm-hover-tip__hpbar" aria-hidden="true">
                <span
                  class={`mm-hover-tip__hpbar-fill mm-hover-tip__hpbar-fill--${v.hpRole}`}
                  style={{ width: `${Math.round(v.hpPct * 100)}%` }}
                />
              </div>
            ) : null}
          </div>
        </Teleport>
      );
    };
  },
});
