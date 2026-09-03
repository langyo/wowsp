import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import "./FitScale.scss";

/**
 * FitScale — scales its child to FILL the host height (down when the
 * window is taller than the space left by the section head, up when it
 * is smaller), so every showcase page reads as one full 100vh screen —
 * no ragged empty bands. Clamped so a tiny window never blasts to
 * billboard size. Transform-only: the window keeps its natural layout
 * box (the section clips any marginal overflow), and the inner is never
 * given an explicit width/height — pinning those to an early,
 * not-yet-laid-out measurement collapsed windows into thin strips.
 */
export default defineComponent({
  name: "FitScale",
  setup(_props, { slots }) {
    const host = ref<HTMLElement | null>(null);
    const inner = ref<HTMLElement | null>(null);
    const scale = ref(1);
    let ro: ResizeObserver | null = null;
    let timers: number[] = [];

    function measure() {
      const h = host.value, i = inner.value;
      if (!h || !i) return;
      const avail = h.clientHeight;
      const natural = i.scrollHeight;
      const availW = h.clientWidth;
      const naturalW = i.scrollWidth;
      // Not laid out yet (async content / fonts still settling) — skip
      // rather than pin a collapsed size. A later re-measure catches it.
      if (natural <= 0 || naturalW <= 0) return;
      // Fill both ways (up AND down), clamped so a tiny window never
      // blasts to billboard size and a wide one never leaves the viewport.
      // The up-fill cap keeps every mock near its natural width: pages
      // are (100dvh − 4rem) tall, so a 1.8× blow-up used to stretch the
      // windows across the whole container.
      const s = Math.min(avail / natural, availW / naturalW);
      scale.value = Math.min(1.35, Math.max(0.35, s));
    }

    onMounted(() => {
      measure();
      ro = new ResizeObserver(measure);
      if (host.value) ro.observe(host.value);
      // Content settles after mount (fonts, images, charts) — re-measure
      // a few times so the fill target is the FINAL size, not the first.
      timers = [80, 400, 1500].map((ms) => window.setTimeout(measure, ms));
      window.addEventListener("resize", measure);
    });
    onBeforeUnmount(() => {
      ro?.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("resize", measure);
    });

    return () => (
      <div ref={host} class="fit-scale">
        <div ref={inner} class="fit-scale__inner" style={{ transform: `scale(${scale.value})` }}>
          {slots.default?.()}
        </div>
      </div>
    );
  },
});