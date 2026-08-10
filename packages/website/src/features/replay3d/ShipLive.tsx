import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  createShipStage,
  type ShipStageFrame,
  type ArmorZone,
} from "@wowsp/holo";
import armorData from "@/data/montanaArmor.json";
import "./ShipLive.scss";

/**
 * ShipLive — the homepage Montana turntable. All three.js logic lives in the
 * shared `createShipStage` controller (@wowsp/holo); this component is just
 * the DOM shell: leader-line overlay, spec chips, mode buttons, tag.
 * Clicking a chip highlights the chip itself — the model stays clean.
 */

const CHIPS = [
  { key: "gun", color: 0xf5b85c },     // 主炮 — gold
  { key: "second", color: 0x38bdf8 },  // 主装甲带 — cyan (armor view only)
  { key: "aa", color: 0xa78bfa },      // 副炮 — violet
] as const;

type ChipKey = (typeof CHIPS)[number]["key"];

/** Chip anchor positions (fractions of the stage box). */
const CHIP_ANCHOR: Record<ChipKey, { x: number; y: number }> = {
  gun: { x: 0.76, y: 0.16 },
  second: { x: 0.76, y: 0.5 },
  aa: { x: 0.76, y: 0.84 },
};

export default defineComponent({
  name: "ShipLive",
  setup() {
    const { t } = useI18n();
    const host = ref<HTMLElement | null>(null);
    const ready = ref(false);
    const activeChip = ref(0);
    const pts = ref<{ x: number; y: number }[][]>(CHIPS.map(() => []));
    const armorOn = ref(false);
    const armorTarget = ref(false);
    const dims = ref({ w: 0, h: 0 });

    let stage: ReturnType<typeof createShipStage> | null = null;

    const armorZones: ArmorZone[] = (armorData as { zones: ArmorZone[] }).zones ?? [];

    function onFrame(f: ShipStageFrame) {
      pts.value = f.pts;
      armorOn.value = f.armorOn;
      armorTarget.value = f.armorTarget;
      dims.value = { w: f.width, h: f.height };
    }

    onMounted(() => {
      if (!host.value) return;
      const base = `${import.meta.env.BASE_URL}replay/conquest-nagato/models/Montana.glb`;
      stage = createShipStage(host.value, {
        modelUrl: base,
        armorZones,
        armorFirst: new URLSearchParams(window.location.search).has("armor"),
        onReady: () => { ready.value = true; },
        onFrame,
      });
    });

    onBeforeUnmount(() => {
      stage?.dispose();
      stage = null;
    });

    return () => {
      const w = dims.value.w, h = dims.value.h;
      return (
        <div class="ship-live" ref={host} data-ready={ready.value ? "" : undefined}>
          {!ready.value ? (
            <div class="ship-live__loading">
              <span class="ship-live__spinner" />
              {t("showcase.ships.loading")}
            </div>
          ) : null}
          {ready.value ? (
            <>
              {/* invisible hover trap — pauses the auto-cycle anywhere over
                  the stage (the stage itself is pointer-events: none) */}
              <div class="ship-live__hoverzone" aria-hidden="true" />
              <svg class="ship-live__leaders" width={w} height={h} aria-hidden="true">
                {CHIPS.map((chip, i) => {
                  const anchor = CHIP_ANCHOR[chip.key];
                  const ax = anchor.x * w;
                  const ay = anchor.y * h;
                  const list = pts.value[i] ?? [];
                  // secondaries: two side groups (port front/rear, starboard
                  // front/rear) each drawn as a fan — two leader lines to the
                  // battery ends with a translucent curtain between them.
                  if (chip.key === "aa") {
                    const sides = [
                      [list[0], list[1]],
                      [list[2], list[3]],
                    ].filter((f) => f.every((p) => p)) as { x: number; y: number }[][];
                    return (
                      <g key={chip.key}>
                        {sides.map((f, fi) => (
                          <g key={fi}>
                            <polygon
                              points={`${ax},${ay} ${f[0].x},${f[0].y} ${f[1].x},${f[1].y}`}
                              class={`ship-live__fan ship-live__fan--${fi === 0 ? "port" : "stbd"}`}
                            />
                            {f.map((p, j) => (
                              <g key={j}>
                                <line
                                  x1={ax} y1={ay} x2={p.x} y2={p.y}
                                  class="ship-live__leader ship-live__leader--aa"
                                />
                                <circle
                                  cx={p.x} cy={p.y} r={4.5}
                                  class={`ship-live__dot ship-live__dot--aa ${i === activeChip.value ? "is-active" : ""}`}
                                />
                              </g>
                            ))}
                          </g>
                        ))}
                      </g>
                    );
                  }
                  return (
                    <g key={chip.key}>
                      {list.map((p, j) => (
                        <g key={j}>
                          <line
                            x1={ax} y1={ay} x2={p.x} y2={p.y}
                            class={`ship-live__leader ship-live__leader--${chip.key}`}
                          />
                          <circle
                            cx={p.x} cy={p.y} r={4.5}
                            class={`ship-live__dot ship-live__dot--${chip.key} ${i === activeChip.value ? "is-active" : ""}`}
                          />
                        </g>
                      ))}
                    </g>
                  );
                })}
              </svg>
              <div class="ship-live__tag">
                <span class="ship-live__tag-dot" />
                {t("showcase.ships.tag")}
              </div>
              {/* top-left mode switch: auto-cycles (pauses on hover), or
                  click a button to jump straight to either phase */}
              <div class="ship-live__modes" role="group" aria-label="view mode">
                <button
                  type="button"
                  class={["ship-live__mode-btn", !armorTarget.value ? "is-active" : ""].join(" ")}
                  onClick={() => stage?.setArmor(false)}
                >
                  {t("showcase.ships.modeHolo")}
                </button>
                <button
                  type="button"
                  class={["ship-live__mode-btn", armorTarget.value ? "is-active" : ""].join(" ")}
                  onClick={() => stage?.setArmor(true)}
                >
                  {t("showcase.ships.modeArmor")}
                </button>
              </div>
              <div class="ship-live__chips">
                {CHIPS.map((chip, i) => {
                  const anchor = CHIP_ANCHOR[chip.key];
                  return (
                    <button
                      type="button"
                      class={["ship-live__chip", i === activeChip.value ? "is-active" : ""].join(" ")}
                      style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
                      onClick={() => { activeChip.value = i; }}
                      key={chip.key}
                    >
                      <span class={`ship-live__chip-dot ship-live__chip-dot--${chip.key}`} />
                      <span class="ship-live__chip-value">
                        {t(`showcase.ships.chip${chip.key === "gun" ? "Gun" : chip.key === "second" ? "Second" : "Aa"}`)}
                      </span>
                      <span class="ship-live__chip-label">
                        {t(`showcase.ships.chip${chip.key === "gun" ? "Gun" : chip.key === "second" ? "Second" : "Aa"}Label`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      );
    };
  },
});
