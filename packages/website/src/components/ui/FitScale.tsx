import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import "./FitScale.scss";

/**
 * FitScale — scales its child to FILL the host height (down when the
 * window is taller than the space left by the section head, up when it
 * is smaller), so every showcase page reads as one full 100vh screen —
 * no ragged empty bands. Clamped so a tiny window never blasts to
 * billboard size. Transform keeps the layout box at natural size; the
 * flex parent centres the result.
 */
export default defineComponent({
  name: "FitScale",
  setup(_props, { slots }) {
    const host = ref<HTMLElement | null>(null);
    const inner = ref<HTMLElement | null>(null);
    const scale = ref(1);
    let ro: ResizeObserver | null = null;

    function measure() {
      const h = host.value, i = inner.value;
      if (!h || !i) return;
      const avail = h.clientHeight;
      const natural = i.scrollHeight;
      const availW = h.clientWidth;
      const naturalW = i.scrollWidth;
      // Fill both ways (up AND down), clamped so a tiny window never
      // blasts to billboard size and a wide one never leaves the viewport.
      const s = Math.min(avail / Math.max(natural, 1), availW / Math.max(naturalW, 1));
      scale.value = Math.min(1.8, Math.max(0.35, s));
    }

    onMounted(() => {
      measure();
      ro = new ResizeObserver(measure);
      if (host.value) ro.observe(host.value);
    });
    onBeforeUnmount(() => ro?.disconnect());

    return () => (
      <div ref={host} class="fit-scale">
        <div ref={inner} class="fit-scale__inner" style={{ transform: `scale(${scale.value})` }}>
          {slots.default?.()}
        </div>
      </div>
    );
  },
});