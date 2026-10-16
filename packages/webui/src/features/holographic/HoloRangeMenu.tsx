/**
 * Combat-range indicator controls of the holographic map: a small icon
 * button at the top-left corner opening a modal of toggles — the master
 * switch, which ring kinds to draw (each row shows its colour and the
 * recorder's stock range), and which surface (2D minimap / 3D scene) to
 * draw them on. The preferences live in rangeRings.ts (persisted), so this
 * component only renders; the rings themselves are painted by the minimap
 * painter and the 3D ring pool. Switches are the standard hikari control —
 * the HUD palette stops at the modal chrome.
 */
import { defineComponent, type PropType } from "vue";
import { LocateFixed } from "@lucide/vue";
import { HkModal, HkSwitch } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import {
  RING_COLOR,
  RING_KINDS,
  rangeRingPrefs,
  type RangeRingDef,
} from "./rangeRings";

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
                <HkSwitch
                  size="sm"
                  modelValue={rangeRingPrefs.enabled}
                  onUpdate:modelValue={(v: boolean) => {
                    rangeRingPrefs.enabled = v;
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
                    <HkSwitch
                      size="sm"
                      modelValue={rangeRingPrefs.kinds[kind]}
                      onUpdate:modelValue={(v: boolean) => {
                        rangeRingPrefs.kinds[kind] = v;
                      }}
                    />
                  </div>
                );
              })}
              <div class="holo-range__section">{i18nT("replay.ranges.surfaces")}</div>
              <div class="holo-range__row">
                <span class="holo-range__name">{i18nT("replay.ranges.minimap")}</span>
                <HkSwitch
                  size="sm"
                  modelValue={rangeRingPrefs.show2d}
                  onUpdate:modelValue={(v: boolean) => {
                    rangeRingPrefs.show2d = v;
                  }}
                />
              </div>
              <div class="holo-range__row">
                <span class="holo-range__name">{i18nT("replay.ranges.scene")}</span>
                <HkSwitch
                  size="sm"
                  modelValue={rangeRingPrefs.show3d}
                  onUpdate:modelValue={(v: boolean) => {
                    rangeRingPrefs.show3d = v;
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
