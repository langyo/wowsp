import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import "./FitScale.scss";

/**
 * FitScale — scales its child DOWN (never up) to fit the host height, so
 * a fixed-height showcase window always sits inside one 100vh section no
 * matter the locale (longer headlines) or viewport. Transform keeps the
 * layout box at natural size; the flex parent centres the result.
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
      scale.value = Math.min(1, avail / Math.max(natural, 1));
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