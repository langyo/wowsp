import { onBeforeUnmount } from "vue";
import { scheduleCronAfter, type CronHandle } from "@/theme/cronBus";
import { reportTransition, type AnimationHandle } from "@/theme/animationBus";

export interface ReportedTransitionTrack {
  run(): void;
  cancel(): void;
}
export interface ReportedTransition extends ReportedTransitionTrack {
  track(key: string): ReportedTransitionTrack;
}

export function useReportedTransition(durationMs: number): ReportedTransition {
  const handles = new Map<string, { anim?: AnimationHandle; cron?: CronHandle }>();
  let mainKey = "";

  function track(key: string): ReportedTransitionTrack {
    return {
      run() {
        const existing = handles.get(key);
        existing?.anim?.disconnect();
        existing?.cron?.disconnect();
        const anim = reportTransition(durationMs);
        const cron = scheduleCronAfter(() => { anim.disconnect(); }, durationMs + 100);
        handles.set(key, { anim, cron });
      },
      cancel() {
        const h = handles.get(key);
        h?.anim?.disconnect();
        h?.cron?.disconnect();
        handles.delete(key);
      },
    };
  }

  onBeforeUnmount(() => {
    for (const h of handles.values()) {
      h.anim?.disconnect();
      h.cron?.disconnect();
    }
    handles.clear();
  });

  return {
    run: () => track(mainKey).run(),
    cancel: () => track(mainKey).cancel(),
    track,
  };
}
