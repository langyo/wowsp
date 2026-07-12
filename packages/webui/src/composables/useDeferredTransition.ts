import { nextTick, onMounted, ref } from "vue";

/** Defers the `transition` CSS flag for two ticks after mount, preventing the
 *  initial-mount transition from firing. Used by SSidebar (`data-animated`). */
export function useDeferredTransition() {
  const animated = ref(false);
  onMounted(() => {
    nextTick(() => {
      nextTick(() => {
        animated.value = true;
      });
    });
  });
  return { animated };
}
