import { computed, ref, watch, onBeforeUnmount } from "vue";

/**
 * Elapsed battle clock. tempArenaInfo.json carries the battle start as a
 * "DD.MM.YYYY HH:MM:SS" local timestamp; we tick a re-render every second so
 * the live card and the rail entry can show the current battle time.
 */
export function useBattleClock(dateTime: () => string | null | undefined) {
  const now = ref(Date.now());

  let timer: ReturnType<typeof setInterval> | null = null;
  function ensureTimer() {
    if (!timer) timer = setInterval(() => (now.value = Date.now()), 1000);
  }
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Parse "12.07.2026 21:45:00" (game-local) into a ms epoch. */
  function parseStart(dt?: string | null): number | null {
    if (!dt) return null;
    const m = dt.match(
      /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!m) return null;
    const [, d, mo, y, hh, mm, ss] = m;
    const epoch = new Date(
      Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? "0"),
    ).getTime();
    return Number.isFinite(epoch) ? epoch : null;
  }

  const elapsed = computed(() => {
    const start = parseStart(dateTime());
    if (start == null) return null;
    return Math.max(0, Math.floor((now.value - start) / 1000));
  });

  watch(
    elapsed,
    (v) => {
      if (v != null) ensureTimer();
      else stopTimer();
    },
    { immediate: true },
  );
  onBeforeUnmount(stopTimer);

  /** "12:34" / "1:02:03" battle-time label. */
  const label = computed(() => {
    const s = elapsed.value;
    if (s == null) return null;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(sec).padStart(2, "0");
    return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  });

  return { elapsed, label };
}
