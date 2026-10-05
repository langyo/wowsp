/**
 * Combat-range indicator controls of the holographic map: a small icon
 * button at the top-left corner opening a modal of toggles — the master
 * switch, which ring kinds to draw (each row shows its colour and the
 * recorder's stock range), and which surface (2D minimap / 3D scene) to
 * draw them on. The preferences live in rangeRings.ts (persisted), so this
 * component only renders; the rings themselves are painted by the minimap
 * painter and the 3D ring pool.
 */
import { defineComponent, type PropType } from "vue";
import { LocateFixed } from "@lucide/vue";
import { HkModal } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import {
  RING_COLOR,
  RING_KINDS,
  rangeRingPrefs,
  type RangeRingDef,
} from "./rangeRings";

/** Hand-rolled mini switch — the HUD's own chrome, sized to the menu rows. */
const Switch = (props: { on: boolean; onChange: () => void; label: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={props.on}
    aria-label={props.label}
    class={["holo-range__switch", props.on ? "holo-range__switch--on" : ""]}
    onClick={(e: Event) => {
      e.stopPropagation();
      props.onChange();
    }}
  >
    <span class="holo-range__knob" />
  </button>
);

export default defineComponent({
  name: "HoloRangeMenu",
  props: {
    /** Modal open state. */
    open: { type: Boolean, required: true },
    /** The recorder's resolved stock ranges (empty while unresolved). */
    rings: { type: Array as PropType<RangeRingDef[]>, default: () => [] },
    onToggle: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    return () => {
      const metersOf = (kind: string): number | null =>
        props.rings.find((r) => r.kind === kind)?.meters ?? null;
      return (
        <div class="holo-map__rangebtn-wrap">
          <button
            class={["holo-map__lbltoggle", rangeRingPrefs.enabled ? "holo-map__lbltoggle--on" : ""]}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggle();
            }}
            data-hint={i18nT("replay.ranges.title")}
            aria-label={i18nT("replay.ranges.title")}
          >
            <LocateFixed size={14} />
          </button>
          <HkModal
            modelValue={props.open}
            onUpdate:modelValue={(v: boolean) => {
              if (!v) props.onToggle();
            }}
            title={i18nT("replay.ranges.title")}
            width="26rem"
          >
            <div class="holo-range">
              <p class="holo-range__hint">{i18nT("replay.ranges.hint")}</p>
              <div class="holo-range__row holo-range__row--master">
                <span class="holo-range__name">{i18nT("replay.ranges.master")}</span>
                <Switch
                  on={rangeRingPrefs.enabled}
                  label={i18nT("replay.ranges.master")}
                  onChange={() => {
                    rangeRingPrefs.enabled = !rangeRingPrefs.enabled;
                  }}
                />
              </div>
              <div class="holo-range__section">{i18nT("replay.ranges.kindsTitle")}</div>
              {RING_KINDS.map((kind) => {
                const meters = metersOf(kind);
                return (
                  <div key={kind} class="holo-range__row">
                    <span class="holo-range__dot" style={{ background: RING_COLOR[kind] }} />
                    <span class="holo-range__name">{i18nT(`replay.ranges.kind.${kind}`)}</span>
                    <span class="holo-range__value">
                      {kind === "vis"
                        ? i18nT("replay.ranges.visValue")
                        : meters != null
                          ? `${(meters / 1000).toFixed(1).replace(/\.0$/, "")} km`
                          : "—"}
                    </span>
                    <Switch
                      on={rangeRingPrefs.kinds[kind]}
                      label={i18nT(`replay.ranges.kind.${kind}`)}
                      onChange={() => {
                        rangeRingPrefs.kinds[kind] = !rangeRingPrefs.kinds[kind];
                      }}
                    />
                  </div>
                );
              })}
              <div class="holo-range__section">{i18nT("replay.ranges.surfaces")}</div>
              <div class="holo-range__row">
                <span class="holo-range__name">{i18nT("replay.ranges.minimap")}</span>
                <Switch
                  on={rangeRingPrefs.show2d}
                  label={i18nT("replay.ranges.minimap")}
                  onChange={() => {
                    rangeRingPrefs.show2d = !rangeRingPrefs.show2d;
                  }}
                />
              </div>
              <div class="holo-range__row">
                <span class="holo-range__name">{i18nT("replay.ranges.scene")}</span>
                <Switch
                  on={rangeRingPrefs.show3d}
                  label={i18nT("replay.ranges.scene")}
                  onChange={() => {
                    rangeRingPrefs.show3d = !rangeRingPrefs.show3d;
                  }}
                />
              </div>
            </div>
          </HkModal>
        </div>
      );
    };
  },
});
