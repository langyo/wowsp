import { defineStore } from "pinia";
import { ref, watch } from "vue";

import { api, type ArenaInfo } from "@/api";
import { useLanguage } from "@/i18n/useLanguage";
import { buildSelfStats, type SelfStatsModel } from "@/features/replay/liveSelfStats";

/** Snapshot poll cadence while the mine tab is open. The decode itself is
 *  seconds-scale CPU work on late-battle streams, so the interval is
 *  deliberately relaxed; growth-gating (below) skips quiet ticks entirely. */
const POLL_MS = 5000;

/**
 * Live self-stats feed (我的战绩): tails the game's in-progress
 * `temp.wowsreplay` into the pure `buildSelfStats` model. The store outlives
 * the panel — switching tabs mid-battle (or after it ends) keeps the model,
 * matching the roster panel's own retention of the last battle.
 *
 * Lifecycle: the panel `attach()`es on mount / `detach()`es on unmount (the
 * heavy decode only runs while the mine tab is actually open — the game has
 * first claim on the CPU); `setArena()` mirrors the live roster in (a new
 * battle's dateTime wipes the previous model); `settle()` swaps in the full
 * authoritative parse once the finished replay lands.
 */
export const useLiveSelfStore = defineStore("liveSelf", () => {
  const { dataLanguage } = useLanguage();

  const model = ref<SelfStatsModel | null>(null);
  /** idle = no battle; waiting = battle on but nothing decodable yet;
   *  live = snapshots flowing; final = BattleResults merged (settling). */
  const phase = ref<"idle" | "waiting" | "live" | "final">("idle");
  const error = ref<string | null>(null);

  /** The live roster mirror + the battle it belongs to. */
  const arena = ref<ArenaInfo | null>(null);
  const battleStamp = ref<string | null>(null);

  /** Temp-file size at last decode — the growth gate. */
  let lastSize: number | null = null;
  /** The settled replay path already parsed (re-arm per battle). */
  let settledPath: string | null = null;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let consumers = 0;

  /** New battle → wipe the previous model (the roster panel re-arms the
   *  same way on a fresh dateTime). */
  watch(
    () => arena.value?.dateTime ?? null,
    (stamp) => {
      if (stamp != null && stamp !== battleStamp.value) {
        model.value = null;
        phase.value = arena.value ? "waiting" : "idle";
        battleStamp.value = stamp;
        lastSize = null;
        settledPath = null;
      } else if (stamp == null && battleStamp.value != null) {
        // Roster cleared (battle-cap guard / next-battle transition): keep
        // the last model on screen — the ended battle's report stays useful.
        battleStamp.value = null;
      }
    },
  );

  function setArena(next: ArenaInfo | null): void {
    arena.value = next;
    if (!next && phase.value === "idle") return;
    if (!next && phase.value !== "final") phase.value = model.value ? "final" : "idle";
  }

  /** Read phase behind a call so control-flow narrowing from tick()'s
   *  early return cannot hide a settle() that landed mid-decode. */
  function phaseIsFinal(): boolean {
    return phase.value === "final";
  }

  async function tick(): Promise<void> {
    if (inFlight || phaseIsFinal()) return;
    const roster = arena.value;
    if (!roster || roster.vehicles.length === 0) return;
    inFlight = true;
    try {
      const temp = await api.liveTempReplay();
      if (!temp) {
        if (!model.value) phase.value = "waiting";
        return;
      }
      if (lastSize === temp.size) return; // no growth → skip the decode
      lastSize = temp.size;
      const stream = await api.readLiveReplaySnapshot(temp.path);
      const next = buildSelfStats({
        stream,
        roster: roster.vehicles,
        dataLang: dataLanguage.value,
      });
      if (next) {
        // A tick that raced settle() (its decode straddled the settled
        // parse) must not regress the authoritative model back to the
        // older live snapshot — the settle pass is idempotent and would
        // never re-run.
        if (phaseIsFinal() && !next.final) return;
        model.value = next;
        error.value = null;
        phase.value = next.final ? "final" : "live";
      } else if (!model.value) {
        phase.value = "waiting";
      }
    } catch (e) {
      // A torn read racing the game's append is routine mid-battle — keep
      // the last good model and retry on the next tick; surface only as
      // transient state, never a user-facing error for it.
      if (!model.value) error.value = String(e);
    } finally {
      inFlight = false;
    }
  }

  /** Swap in the finished replay's authoritative parse (the settling signal:
   *  a fresh .wowsreplay landed). Idempotent per battle; one delayed retry —
   *  the game can still be flushing the file when the settling poll first
   *  sees it. */
  async function settle(path: string): Promise<void> {
    if (settledPath === path) return;
    settledPath = path;
    await parseSettled(path, true);
  }

  async function parseSettled(path: string, allowRetry: boolean): Promise<void> {
    // A delayed retry must not outlive its battle: if a new arena already
    // re-armed the feed (settledPath moved on), the stale parse would
    // overwrite the new battle's model and pin it "final".
    if (settledPath !== path) return;
    const roster = arena.value;
    try {
      const stream = await api.readReplayPositions(path);
      const next = buildSelfStats({
        stream,
        roster: roster?.vehicles ?? [],
        dataLang: dataLanguage.value,
      });
      if (next) {
        model.value = next;
        phase.value = "final";
        error.value = null;
      }
    } catch (e) {
      if (allowRetry) {
        window.setTimeout(() => void parseSettled(path, false), 2500);
        return;
      }
      // The settled file parse is the authoritative one — worth surfacing,
      // but the live model (if any) stays on screen regardless.
      error.value = String(e);
    }
  }

  /** Panel mounted → start polling (first tick immediate). */
  function attach(): void {
    consumers += 1;
    if (timer == null) {
      void tick();
      timer = setInterval(() => void tick(), POLL_MS);
    }
  }

  /** Panel unmounted → stop once the last consumer is gone. */
  function detach(): void {
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { model, phase, error, setArena, settle, attach, detach };
});
