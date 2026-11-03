import { defineComponent, type PropType } from "vue";

import { HkTag } from "@celestia-island/hikari";
import "./AppTag.scss";

/**
 * AppTag — the app's ONE tag primitive, pressed on hikari's HkTag base.
 *
 * Why this exists: the 2026-11-03 tag unification found every surface
 * pressing its own pill (replay-card__pill, replay-view__pill,
 * resources-view__count, mod-detail__tag, chip, tex-tag, ... — nine SCSS
 * files re-stating the same anatomy with drifting fonts, radii and ink).
 * The unification contract is "source unified, props local": every label
 * in the app renders through THIS component; the hikari base supplies the
 * anatomy (HkTag's .hk-tag DOM, its sm/md scale, its icon/close slots)
 * and the SOFT face verbatim; this file's SCSS adds only what hikari's
 * 0.55.x tag lacks — the SOLID and OUTLINE faces, the accent/event tones
 * and the app's pill radius — as overloads keyed to the same class hooks.
 *
 * Faces (prop `face`):
 * - "soft"    — hikari's own tinted tag (10% tone bg + tone ink + 20%
 *               border). The default: a classification label. For the six
 *               hikari tones this is LITERALLY HkTag's CSS, untouched.
 * - "solid"   — filled tone, on-solid ink (实心). Strong state voices:
 *               alarms (crash pins' 未知), unfinished counters, active
 *               emphasis. Ink per theme.scss's solid conventions (white
 *               on warning/accent/danger fills, scheme ink on primary).
 * - "outline" — transparent plate + tone border + tone ink (空心). The
 *               affordance/jump voice (map tag, server-scope tag) and the
 *               quiet neutral chip (category chips at rest).
 *
 * Tones (prop `tone`): hikari's six (default/primary/success/warning/
 * danger/info) plus the app's own:
 * - "accent" — the amber battle voice (--color-accent: 行动/对决 pills,
 *              loader-health). Hikari has no accent tone; the soft face
 *              restates hikari's tint recipe over --color-accent.
 * - "event"  — the violet 活动/赛事 voice. Deletes the two literal-violet
 *              .hk-tag overrides (ShipsView / ShipDetailModal).
 *
 * Size: the app default is `sm` (hikari text-2xs, 10px) — one step below
 * hikari's md default, the 统一小一号 direction (2026-11-03); pass
 * `size="md"` only where a surface's hierarchy deliberately wants 12px.
 *
 * `interactive` renders a real <button> AROUND the HkTag face (HkTag is
 * a span and must not take click listeners): category chips, the install
 * tag, the map tag — anything pressed WHERE a click means something.
 * Interactive and closable are mutually exclusive (closable wins as a
 * no-op under interactive — a button must not nest a button).
 *
 * `pill` (default) rounds to --radius-full: the app's label voice is the
 * full pill everywhere (2026-11-03 audit); `pill={false}` keeps hikari's
 * radius-sm rect for the few rect-voice contexts.
 *
 * `color` paints the tag from a RAW CSS color (any string, theme vars
 * included) instead of a tone: the battle-mode pills key off
 * modeColor()'s per-mode hexes, the holo tooltip's var(--tip-tag), etc.
 * The whole face paint goes INLINE (inline beats the ui-opacity dial and
 * every sheet), so the prop is the full-override escape hatch — tone+
 * face remain the token route. Solid with `color` follows the project's
 * white-ink-on-solid convention.
 *
 * Attrs fall through (class, data-hint, aria-pressed, title, ...): on a
 * plain tag they land on the HkTag span; interactive they land on the
 * button. The `close` event re-emits HkTag's.
 */
export type AppTagTone =
  | "default"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent"
  | "event";
export type AppTagFace = "soft" | "solid" | "outline";

/** HkTag carries six tones; the app's two ride the closest hikari variant
 *  underneath (the DOM must keep a valid .hk-tag-* class for the soft
 *  face's anatomy) while AppTag.scss restates their colors. */
const HK_VARIANT: Record<AppTagTone, "default" | "primary" | "success" | "warning" | "danger" | "info"> = {
  default: "default",
  primary: "primary",
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
  accent: "warning",
  event: "primary",
};

/** Inline face paint for the raw `color` escape hatch: mixes every face
 *  straight from the given color so no sheet (the ui-opacity dial
 *  included) can out-rank it. The soft tint follows the mode-pill voice
 *  the audit found (18% tint, borderless); solid carries white ink per
 *  the project's on-solid convention. */
function customFaceStyle(face: AppTagFace, color: string): Record<string, string> {
  if (face === "outline") {
    return {
      background: "transparent",
      "border-color": `color-mix(in srgb, ${color} 45%, transparent)`,
      color,
    };
  }
  if (face === "solid") {
    return { background: color, "border-color": "transparent", color: "#fff" };
  }
  return {
    background: `color-mix(in srgb, ${color} 18%, transparent)`,
    "border-color": "transparent",
    color,
  };
}

export default defineComponent({
  name: "AppTag",
  inheritAttrs: false,
  props: {
    tone: { type: String as PropType<AppTagTone>, default: "default" },
    face: { type: String as PropType<AppTagFace>, default: "soft" },
    size: { type: String as PropType<"sm" | "md">, default: "sm" },
    interactive: { type: Boolean, default: false },
    closable: { type: Boolean, default: false },
    closeLabel: { type: String, default: undefined },
    pill: { type: Boolean, default: true },
    /** Raw CSS color overriding the tone's ink (mode pills, holo vars).
     * Painted inline — see the header note. */
    color: { type: String, default: undefined },
    /** Monospace ink for version/telemetry strings (HkBadge's `mono`
     * contract: same prop name, one custom-property line of CSS). */
    mono: { type: Boolean, default: false },
    /** Interactive only: forwarded onto the wrapper button (a busy shot
     * button, a disabled toggle). Ignored on static tags. */
    disabled: { type: Boolean, default: false },
  },
  emits: {
    close: () => true,
    click: (_e: MouseEvent) => true,
  },
  setup(props, { attrs, emit, slots }) {
    // Capture the slot fns once: TS loses the truthiness narrowing inside
    // the render closures, and the slots object may be replaced per render.
    const iconSlot = slots.icon;
    const defaultSlot = slots.default;
    return () => {
      const { class: hostClass, ...rest } = attrs as {
        class?: unknown;
        [key: string]: unknown;
      };
      // Interactive: the wrapper button carries every attr (data-hint,
      // aria-pressed, disabled, onClick-through-emit...); the inner face
      // span must not duplicate them.
      const innerRest = props.interactive ? {} : rest;
      const tagClass = [
        "app-tag",
        `app-tag--${props.tone}`,
        props.face !== "soft" ? `app-tag--${props.face}` : "",
        props.pill ? "app-tag--pill" : "",
        props.mono ? "app-tag--mono" : "",
        // Static tags merge the host class onto the SAME element (the
        // HkTag span); interactive moves it to the button below.
        ...(props.interactive ? [] : [hostClass as string]),
      ];
      const tag = (
        <HkTag
          {...innerRest}
          variant={HK_VARIANT[props.tone]}
          size={props.size}
          closable={props.closable && !props.interactive}
          closeLabel={props.closeLabel}
          onClose={() => emit("close")}
          /* Clicks ride the INTERACTIVE mode (the declared click emit routes
             through the wrapper button); a static span takes no listener. */
          class={tagClass}
          style={props.color ? customFaceStyle(props.face, props.color) : undefined}
        >
          {{
            icon: iconSlot ? () => iconSlot() : undefined,
            default: defaultSlot ? () => defaultSlot() : undefined,
          }}
        </HkTag>
      );
      if (props.interactive) {
        return (
          <button
            {...rest}
            type="button"
            disabled={props.disabled || undefined}
            class={["app-tag-btn", hostClass]}
            onClick={(e: MouseEvent) => emit("click", e)}
          >
            {tag}
          </button>
        );
      }
      return tag;
    };
  },
});
