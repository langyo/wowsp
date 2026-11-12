/**
 * The unified resource-download context.
 *
 * Every runtime resource the app can pull — the app installer, the resource
 * pack, the baked data pack, mod-hub packages and the signed decision-model
 * pack — streams its progress on ONE transport bus
 * (`wowsp://download-progress`, fanned out by `api.listenDownloadProgress`).
 * What used to be missing was the layer ABOVE that bus: each owning store kept
 * its own progress slice and rendered it INSIDE the settings pane, so the same
 * pass looked different depending on which card happened to be open, and a
 * resource started from anywhere else had no progress surface at all.
 *
 * This store is that layer. It owns, once for every context:
 *
 * - the CONTEXT REGISTRY — one declarative row per download kind: what the
 *   resource is called, which presentation owns it (the shared top-right card,
 *   a bespoke pass card, or nothing at all) and which cancel verb aborts it.
 *   Adding a resource means adding a row here, never another listener.
 * - the PASS LEDGER — one `ResourcePass` per kind, fed by the bus ticks and
 *   gated by the owning command's lifetime (`track`), so "is this context
 *   running?" has exactly ONE answer (`busyFor`, never a phase heuristic).
 * - the PASS LIFECYCLE — `track()` raises the pass, folds a rejection into
 *   `error` (a requested cancel stays neutral), settles it and announces the
 *   outcome the shared card cannot show (a pass that ended inside the card's
 *   mount grace earns a toast instead of a flash).
 * - the ONE presentation decision: resource passes (`res-pack`, `ai-models`)
 *   are shown by the shared DownloadToast card in the top-right toast stack —
 *   never inline in a settings card. The app updater and the mod batch keep
 *   their own bespoke cards (they carry richer, pass-specific copy), and
 *   boot-time lanes (`data-pack`) stay silent by registry declaration.
 *
 * Stores that own a command become CONTEXT OWNERS: they call `track(kind, job)`
 * instead of registering a listener and hand-rolling a progress ref, so the
 * presentation cannot drift away from the transport again.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { useToast } from "@celestia-island/hikari";

import { api, type DownloadProgress } from "@/api";
import { t } from "@/i18n";

/** Who renders a running pass of this kind.
 *  - "card"     the shared DownloadToast top-right card (this store drives it);
 *  - "bespoke"  a pass-specific card the owning store drives itself
 *               (UpdateToast / ModUpdateToast) — registered here so the
 *               registry stays complete and one place owns the vocabulary;
 *  - "silent"   never presented (boot-time data lanes). */
export type DownloadPresentation = "card" | "bespoke" | "silent";

/** One row of the download-context registry. */
export interface DownloadContextSpec {
  /** The bus kind (`wowsp_tauri_shared::download::kind`). */
  kind: string;
  presentation: DownloadPresentation;
  /** i18n key naming the resource — the shared card's headline label. Only
   *  card contexts need one (bespoke cards bring their own copy). */
  labelKey?: string;
  /** The context's cancel verb. Absent = the pass cannot be aborted (mod
   *  catalog installs, the boot-time data lanes). */
  cancel?: () => Promise<unknown>;
}

/**
 * The registry, in display priority order. Keep the kinds in lock-step with
 * `wowsp_tauri_shared::download::kind` and docs/en/designs/resources.md —
 * the Rust side is the producer contract, this is the presentation contract.
 */
export const DOWNLOAD_CONTEXTS: readonly DownloadContextSpec[] = [
  {
    kind: "update",
    presentation: "bespoke",
  },
  {
    kind: "res-pack",
    presentation: "card",
    labelKey: "settings.resPackTitle",
    cancel: () => api.resCancel(),
  },
  {
    kind: "ai-models",
    presentation: "card",
    labelKey: "settings.resourcesDecisionsName",
    cancel: () => api.aiPackCancel(),
  },
  {
    kind: "data-pack",
    presentation: "silent",
  },
  {
    kind: "mod-package",
    presentation: "bespoke",
  },
];

/** Mount grace before the shared card appears: a pass that lands inside this
 *  window (a cached/no-op run, an instant refusal) must not flash a card —
 *  its outcome is a toast. Mirrors the mod pass card's grace contract. */
export const DOWNLOAD_CARD_GRACE_MS = 400;

/** Phases that mean "the pass is over". */
const TERMINAL_PHASES = new Set(["done", "error"]);

/** One context's live pass. Absent = the context never ran this session. */
export interface ResourcePass {
  kind: string;
  /** Bus phase: queued | race | verify | download | apply | installing |
   *  install | done | error. */
  phase: string;
  received: number;
  total: number;
  /** Smoothed transfer rate (bytes/sec), 0 while not streaming. */
  speedBps: number;
  /** Chain-patch segment counters (1/1 for a single-artifact pass). */
  segment: number;
  segments: number;
  error: string | null;
  /** True while the owning command is in flight — the authoritative
   *  "this context is running" answer (ticks alone cannot say it: a queued
   *  or stalled pass emits none). */
  busy: boolean;
  /** True once the user asked to cancel; the command's rejection is then
   *  expected and must not read as a failure. */
  cancelling: boolean;
  /** When the pass started (ms) — the card's mount-grace reference. */
  startedAt: number;
  /** Wall clock of the newest tick (ms) — orders concurrent passes. */
  updatedAt: number;
}

/** The pass percentage a card renders, or null while the phase carries no
 *  fraction (queued, racing, applying, unknown total). */
export function passPercent(pass: ResourcePass | null): number | null {
  if (!pass || pass.phase !== "download" || pass.total <= 0) return null;
  return Math.min(100, Math.round((pass.received / pass.total) * 100));
}

/** True while the pass has not reported a terminal phase. */
export function passLive(pass: ResourcePass | null): boolean {
  return pass != null && !TERMINAL_PHASES.has(pass.phase);
}

function specFor(kind: string): DownloadContextSpec | undefined {
  return DOWNLOAD_CONTEXTS.find((spec) => spec.kind === kind);
}

/** The shared card's kinds, in display priority order. */
const CARD_KINDS = DOWNLOAD_CONTEXTS.filter((spec) => spec.presentation === "card").map(
  (spec) => spec.kind,
);

export const useDownloadsStore = defineStore("downloads", () => {
  const toast = useToast();
  /** Pass ledger, keyed by kind. A plain object (Vue instruments mutations)
   *  so the card and the inline read-outs re-render on every tick. */
  const passes = ref<Record<string, ResourcePass>>({});
  let wired = false;

  /** Wire the ONE bus registration this layer owns. Idempotent (the api
   *  module fans the transport listener out to every subscriber), so the
   *  first owner to raise a pass brings the bus up for the whole app. */
  function ensureWired(): void {
    if (wired) return;
    wired = true;
    try {
      api.listenDownloadProgress?.((tick: DownloadProgress) => noteTick(tick));
    } catch {
      // No transport (browser dev / older shell): passes still run through
      // `track` and simply never receive byte ticks.
    }
  }

  /** Fold one bus tick into its context's pass. A tick for a context that is
   *  not in the ledger is ignored: the ledger is raised by `track`, never by
   *  stray events (a ghost card must be impossible). */
  function noteTick(tick: DownloadProgress): void {
    const current = passes.value[tick.kind];
    if (!current) return;
    const detail = tick.detail ?? {};
    passes.value = {
      ...passes.value,
      [tick.kind]: {
        ...current,
        phase: tick.phase,
        received: tick.received,
        total: tick.total,
        speedBps: tick.phase === "download" && tick.speedBps > 0 ? tick.speedBps : 0,
        segment: detail.segment ?? current.segment,
        segments: detail.segments ?? current.segments,
        error: tick.error ?? current.error,
        updatedAt: Date.now(),
      },
    };
  }

  /** Raise (or reset) one context's pass. */
  function begin(kind: string, phase = "queued"): void {
    ensureWired();
    const now = Date.now();
    passes.value = {
      ...passes.value,
      [kind]: {
        kind,
        phase,
        received: 0,
        total: 0,
        speedBps: 0,
        segment: 1,
        segments: 1,
        error: null,
        busy: true,
        cancelling: false,
        startedAt: now,
        updatedAt: now,
      },
    };
  }

  /** Settle one context's pass. Terminal state stays in the ledger so the
   *  shared card can fold out on it; a later `begin` overwrites it. */
  function settle(kind: string, error: string | null): void {
    const current = passes.value[kind];
    if (!current) return;
    passes.value = {
      ...passes.value,
      [kind]: {
        ...current,
        phase: error ? "error" : "done",
        error,
        busy: false,
        cancelling: false,
        speedBps: 0,
        updatedAt: Date.now(),
      },
    };
  }

  /**
   * Run one context's command with the shared lifecycle: raise the pass, await
   * the command, fold a rejection into the pass (a requested cancel stays
   * neutral), settle it, then announce the outcome the card cannot show.
   *
   * The rejection is NOT rethrown: callers still refresh their own status
   * afterwards, and the outcome travels in the result (with the command's
   * value) so they can gate on it without a try/catch of their own — a boot
   * path that hands the value on can rethrow deliberately.
   *
   * `quiet` suppresses the OUTCOME announcements only (the pass and its card
   * still run): boot-time lanes keep their historical silence about failures,
   * which are not the user's doing and would nag on every offline launch.
   */
  async function track<T>(
    kind: string,
    job: () => Promise<T>,
    options: { quiet?: boolean } = {},
  ): Promise<{ ok: boolean; value: T | null; error: string | null }> {
    const spec = specFor(kind);
    begin(kind);
    const startedAt = Date.now();
    let value: T | null = null;
    let error: string | null = null;
    try {
      value = await job();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (passes.value[kind]?.cancelling) {
      // A user cancel is not a failure: the card folds quietly and no error
      // toast fires (the pass card's own cancel action was the intent).
      error = null;
    }
    settle(kind, error);
    if (!options.quiet) {
      if (error) {
        toast.error(t("settings.downloadFailedDetail", { message: error }));
      } else if (spec?.presentation === "card" && Date.now() - startedAt < DOWNLOAD_CARD_GRACE_MS) {
        // The card never mounts inside the grace window — say it worked.
        const label = spec.labelKey ? t(spec.labelKey) : kind;
        toast.success(t("settings.downloadDone", { label }));
      }
    }
    return { ok: error == null, value, error };
  }

  /** Abort one running pass through its registry cancel verb. */
  async function cancel(kind: string): Promise<void> {
    const current = passes.value[kind];
    if (!current || !current.busy || current.cancelling) return;
    passes.value = { ...passes.value, [kind]: { ...current, cancelling: true } };
    try {
      await specFor(kind)?.cancel?.();
    } catch {
      /* best-effort — the command's own rejection settles the pass */
    }
  }

  /** The pass the shared card shows: the newest LIVE card pass, else the
   *  newest settled one (the fold-out snapshot). Null while every card
   *  context is idle. */
  const cardPass = computed<ResourcePass | null>(() => {
    let live: ResourcePass | null = null;
    let settled: ResourcePass | null = null;
    for (const kind of CARD_KINDS) {
      const pass = passes.value[kind];
      if (!pass) continue;
      if (pass.busy) {
        if (!live || pass.updatedAt >= live.updatedAt) live = pass;
      } else if (!settled || pass.updatedAt >= settled.updatedAt) {
        settled = pass;
      }
    }
    return live ?? settled;
  });

  /** True while any card context runs — the shared card's raise signal. */
  const running = computed(() => cardPass.value?.busy ?? false);

  /** The pass of one kind (null when the context never ran). */
  function passFor(kind: string): ResourcePass | null {
    return passes.value[kind] ?? null;
  }

  /** True while the given context is in flight — the settings cards' button
   *  gating (one source of truth, never a phase heuristic). */
  function busyFor(kind: string): boolean {
    return passes.value[kind]?.busy ?? false;
  }

  /** The localized resource name of one kind (the registry's labelKey). An
   *  unknown kind or a context without a label falls back to the raw id, so a
   *  card always renders something. */
  function labelFor(kind: string): string {
    const key = specFor(kind)?.labelKey;
    return key ? t(key) : kind;
  }

  /** The last failure of one context, kept for the owning card's inline
   *  retry hint (progress is a toast concern; a failure the user must act on
   *  stays beside the button that retries it). */
  function errorFor(kind: string): string | null {
    const pass = passes.value[kind];
    return pass && !pass.busy && pass.phase === "error" ? pass.error : null;
  }

  /** Drop one context's settled pass (the owner cleared its error / retried). */
  function clear(kind: string): void {
    const current = passes.value[kind];
    if (!current || current.busy) return;
    const next = { ...passes.value };
    delete next[kind];
    passes.value = next;
  }

  return {
    passes,
    cardPass,
    running,
    ensureWired,
    begin,
    settle,
    track,
    cancel,
    passFor,
    busyFor,
    errorFor,
    labelFor,
    clear,
  };
});