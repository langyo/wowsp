/**
 * PlaneModelMenu — the ship-detail airframe dropdown's listbox body.
 *
 * The stage's picker lists the hull first, then every airframe the ship can
 * embark, grouped under that airframe's combat role (torpedo / AP bomber /
 * rocket …) so a carrier's six airframes read as three two-row sections
 * instead of one flat run of names. Each airframe row names the aircraft
 * model designation; sections that offer both versions of a configuration
 * additionally carry a tiny base/variant tag (the base aircraft of a hull
 * configuration vs its upgraded counterpart), and a row keeps that tag when
 * its label alone would be swallowed by a duplicate in a mixed section. Rows
 * sharing an unmapped role
 * ("" — plane_types.json does not cover the airframe, or the locale does not
 * translate it) land in one trailing group that renders bare: headings only
 * make sense for named roles.
 *
 * Presentational by contract: the host (ShipStage) owns the popover state,
 * the outside-click / Escape handling and the staged selection. This
 * component only renders the rows and emits the clicked value.
 */
import { defineComponent, type PropType } from "vue";

import { t, te } from "@/i18n";
import {
  groupPlaneModelOptions,
  showsVersionTag,
  type PlaneModelOption,
} from "./shipSquadrons";

export default defineComponent({
  name: "PlaneModelMenu",
  props: {
    /** Flat picker rows in canonical order (role, then version rank); the
     *  component groups them for display only. */
    options: { type: Array as PropType<PlaneModelOption[]>, default: () => [] },
    /** The staged picker value: "hull" or an airframe index. */
    selected: { type: String, default: "hull" },
  },
  emits: {
    /** A row was activated — the value is "hull" or the airframe index. */
    select: (_index: string) => true,
  },
  setup(props, { emit }) {
    /** Role heading text; "" for the unlabelled fallback bucket and for a
     *  role key the active locale does not translate (te() probes without
     *  t()'s missing-key warning, and the echoed key path must not leak into
     *  the menu as a heading). */
    function roleLabel(role: string): string {
      if (!role) return "";
      const key = `ships.plane.${role}`;
      return te(key) ? t(key) : "";
    }

    return () => (
      <div
        class="ship-stage__model-pick-menu-inner"
        role="listbox"
        aria-label={t("ships.detail.stage.modelPicker")}
      >
        <button
          type="button"
          role="option"
          aria-selected={props.selected === "hull"}
          class={[
            "ship-stage__model-pick-item",
            props.selected === "hull" ? "is-active" : "",
          ].join(" ")}
          onClick={() => emit("select", "hull")}
        >
          {t("ships.detail.stage.hull")}
        </button>
        {groupPlaneModelOptions(props.options).map((group) => {
          const heading = roleLabel(group.role);
          return (
            <div
              key={group.role}
              class="ship-stage__model-pick-group"
              role="group"
              aria-label={heading || undefined}
            >
              {heading ? (
                <div class="ship-stage__model-pick-group-label">{heading}</div>
              ) : null}
              {group.options.map((option) => {
                // Sections offering both versions tag every row; a mixed
                // section only tags the row a sibling's identical label
                // would otherwise swallow (see showsVersionTag).
                const config = showsVersionTag(group, option) ? option.config : null;
                const tag = config ? t(`ships.plane.cfg.${config}`) : "";
                return (
                  <button
                    key={option.index}
                    type="button"
                    role="option"
                    aria-selected={props.selected === option.index}
                    class={[
                      "ship-stage__model-pick-item",
                      props.selected === option.index ? "is-active" : "",
                    ].join(" ")}
                    title={[heading, option.label, tag].filter(Boolean).join(" · ")}
                    onClick={() => emit("select", option.index)}
                  >
                    <span class="ship-stage__model-pick-item-label">{option.label}</span>
                    {config ? (
                      <span class={["ship-stage__model-pick-tag", `is-${config}`].join(" ")}>
                        {tag}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  },
});
