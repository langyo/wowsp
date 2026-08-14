import { onMounted, onUnmounted, ref, type Ref } from "vue";

/**
 * Scroll-reveal composable: adds the `reveal` class (CSS in theme.scss) and
 * flips it to `is-visible` when the element enters the viewport. Mirrors the
 * IntersectionObserver pattern from e.celestia.world.
 *
 * Usage in TSX: `ref={r.setEl}` (callback ref — object refs are unreliable
 * in JSX render functions).
 */
export function useScrollReveal(delay = 0) {
  const el = ref<Element | null>(null);
  const visible = ref(false);
  let obs: IntersectionObserver | null = null;

  function setEl(node: Element | null) {
    el.value = node;
  }

  function isInViewport(node: Element): boolean {
    const r = node.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top < vh * 0.92 && r.bottom > 0;
  }

  function revealIfVisible() {
    if (visible.value || !el.value) return;
    if (isInViewport(el.value)) {
      visible.value = true;
      obs?.disconnect();
      window.removeEventListener("scroll", onScroll);
    }
  }

  function onScroll() {
    revealIfVisible();
  }

  onMounted(() => {
    if (!el.value) return;
    if (typeof IntersectionObserver !== "undefined") {
      obs = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            visible.value = true;
            obs?.disconnect();
            window.removeEventListener("scroll", onScroll);
          }
        },
        { threshold: 0.15 },
      );
      obs.observe(el.value);
    }
    // Fallback (also covers viewport resize / harness quirks):
    revealIfVisible();
    window.addEventListener("scroll", onScroll, { passive: true });
  });

  onUnmounted(() => {
    obs?.disconnect();
    window.removeEventListener("scroll", onScroll);
  });

  return {
    el: el as Ref<HTMLElement | null>,
    setEl,
    cls: () => (visible.value ? "reveal is-visible" : "reveal"),
    style: () => ({ transitionDelay: delay ? `${delay}ms` : undefined }),
  };
}
