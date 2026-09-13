/**
 * Thin headless renderer over the useImage() hook (@wowsp/holo) for
 * images rendered inside maps, where a per-item hook call is not
 * possible. The <img> keeps any host-provided class so existing
 * component SCSS keeps applying; the element fades in via
 * `image-asset__img` once loaded and a centered `fallback` glyph is
 * shown while the source is absent or failed. This is local sugar —
 * the contract is useImage + the image-asset__* classes.
 */
import { defineComponent, h, type PropType, type VNode } from "vue";
import { useImage } from "@wowsp/holo";

export const AssetImage = defineComponent({
  name: "AssetImage",
  inheritAttrs: false,
  props: {
    src: { type: String as PropType<string | null | undefined>, default: null },
    alt: { type: String, default: "" },
    loading: { type: String as PropType<"eager" | "lazy">, default: "eager" },
    /** Intrinsic sizing hints, forwarded to the <img> (e.g. ribbon icons). */
    width: { type: [String, Number] as PropType<string | number | undefined>, default: undefined },
    height: { type: [String, Number] as PropType<string | number | undefined>, default: undefined },
    /** Shown (centered) when the source is absent or failed to load. */
    fallback: { type: Object as PropType<VNode | null>, default: null },
    /** Title for the fallback area (e.g. a localized "image unavailable"). */
    fallbackTitle: { type: String, default: "" },
    /** Invoked once when the current source transitions loading → error (not for stale events). */
    onError: { type: Function as PropType<() => void>, default: undefined },
  },
  setup(props, { attrs }) {
    const img = useImage(() => props.src);
    function handleImgError(): void {
      const statusBefore = img.status.value;
      img.onError();
      // Only a fresh loading → error transition counts; stale events are dropped.
      if (statusBefore === "loading" && img.status.value === "error") props.onError?.();
    }
    return () => {
      const loaded = img.status.value === "loaded";
      const showFallback =
        props.fallback !== null && (img.status.value === "empty" || img.status.value === "error");
      const { class: hostClass, ...rest } = attrs as { class?: unknown } & Record<string, unknown>;
      return [
        img.src.value
          ? h("img", {
              ...rest,
              key: img.key.value,
              src: img.src.value,
              alt: props.alt,
              loading: props.loading,
              width: props.width,
              height: props.height,
              draggable: false,
              class: [hostClass, "image-asset__img", loaded ? "is-loaded" : null],
              onLoad: img.onLoad,
              onError: handleImgError,
            })
          : null,
        showFallback
          ? h(
              "span",
              { class: "image-asset__fallback", title: props.fallbackTitle || undefined },
              [props.fallback],
            )
          : null,
      ];
    };
  },
});
