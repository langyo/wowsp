/**
 * The unified download context.
 *
 * EVERY runtime download the app can start — the app installer, the resource
 * pack, the baked data pack, mod-hub packages and the signed decision-model
 * pack — is a CONTEXT of this store. It owns, once for all of them:
 *
 * - the CONTEXT REGISTRY: one declarative row per bus kind — localized label,
 *   presentation, where the numbers come from, cancel verb. Adding a
 *   downloadable resource is a row here, never a second progress surface.
 * - the PASS LEDGER: one `ResourcePass` per kind, gated by the owning
 *   command's lifetime, so "is this running?" has exactly ONE answer
 *   (`busyFor`) instead of a per-store phase heuristic.
 * - the PASS LIFECYCLE: `track()` raises / folds / settles a pass, keeps a
 *   user cancel neutral, and turns the outcomes a folded card cannot show into
 *   toasts. Batch owners use `begin` + `report` + `settle` instead.
 * - the PRESENTATION: the single top-right DownloadToast card. Every
 *   download renders there — never inline in a settings pane, never a second
 *   bespoke card. A pass carries a headline, a step line and one fraction, so
 *   one card can serve a single file stream and a multi-item batch alike.
 *
 * Two ways a pass gets its numbers:
 *
 * - `source: "bus"` — the unified `wowsp://download-progress` stream folds
 *   its ticks into the pass. One artifact, one stream (installer, resource
 *   pack, AI pack).
 * - `source: "owner"` — the owning store PUSHES the pass with `report()`.
 *   That is the batch shape: several artifacts behind one overall percent, so
 *   a raw per-file tick cannot be the card's number (the plugin update pass).
 *
 * The store deliberately knows nothing about what a resource IS: labels come
 * from the registry (or the owner), versions and inventory stay with the
 * owning store.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { useToast } from "@celestia-island/hikari";

import { api, type DownloadProgress } from "@/api";
import { t } from "@/i18n";
import { RPC } from "@/rpc";
import { invoke } from "@tauri-apps/api/core";

/** Who renders a running pass of this kind.
 *  - "card"    the shared DownloadToast top-right card (this store drives it);
 *  - "silent"  never presented (boot-time data lanes).
 *
 *  A previous revision had a "bespoke" value: the app updater and the plugin
 *  batch kept private cards because their copy is pass-specific. That split —
 *  not the copy — was the problem: two more cards, two more mount machines,
 *  two more ways for "is it running?" to go stale. The shared card absorbed
 *  them: a pass carries a STEP line and an owner-computed fraction, which is
 *  everything those cards ever showed. */
export type DownloadPresentation = "card" | "silent";

/** Where a pass's numbers come from.
 *  - "bus"    the unified progress bus folds its ticks (one stream);
 *  - "owner"  the owning store pushes the pass (a batch behind one percent);
 *  - "none"   nothing to show. */
export type DownloadProgressSource = "bus" | "owner" | "none";

/** One row of the download-context registry. */
export interface DownloadContextSpec {
  /** The bus kind (`wowsp_tauri_shared::download::kind`). */
  kind: string;
  presentation: DownloadPresentation;
  /** i18n key naming the resource — the card's headline. Owner-driven
   *  contexts resolve their own headline instead (a batch names its item). */
  labelKey?: string;
  /** Where the numbers come from (default "bus"). */
  source?: DownloadProgressSource;
  /** The context's cancel verb. Absent = the pass cannot be aborted. */
  cancel?: () => Promise<unknown>;
}

/**
 * The registry, in display priority order. Keep the kinds in lock-step with
 * `wowsp_tauri_shared::download::kind` and docs/en/designs/resources.md — the
 * Rust side is the producer contract, this is the presentation contract.
 */
export const DOWNLOAD_CONTEXTS: readonly DownloadContextSpec[] = [
  {
    kind: "update",
    presentation: "card",
    labelKey: "settings.updatesAppName",
    // The updater's own cancel: the part file survives as the resume base.
    cancel: () => invoke(RPC.update_cancel),
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
    source: "none",
  },
  {
    kind: "mod-package",
    presentation: "card",
    labelKey: "resources.pluginUpdateCardLabel",
    source: "owner",
    // Catalog installs cannot be aborted mid-flight (the Rust side writes the
    // tree atomically); the pass runs to completion and folds failures.
  },
];

/** Mount grace before the shared card appears: a pass that lands inside this
 *  window must not flash a card — its outcome is a toast. One number for every
 *  context (the store's own announcement branches on it too). */
export const DOWNLOAD_CARD_GRACE_MS = 400;

/** Phases that mean "the pass is over". */
const TERMINAL_PHASES = new Set(["done", "error"]);

/** One context's live pass. Absent = the context never ran this session. */
export interface ResourcePass {
  kind: string;
  /** Bus phase (queued | race | verify | download | apply | installing |
   *  install | done | error) or an owner-pushed verb of the same vocabulary. */
  phase: string;
  /** The card's headline — a registry label, or the owner's own text (the
   *  item a batch is on). */
  label: string;
  /** The card's second line — a phase verb, or the owner's step text
   *  ("mod-a (2/3)"). Empty = the card renders only the headline. */
  step: string;
  received: number;
  total: number;
  /** Smoothed transfer rate (bytes/sec), 0 while not streaming. */
  speedBps: number;
  /** Chain-patch segment counters (1/1 for a single-artifact pass). */
  segment: number;
  segments: number;
  /** OWNER-computed overall fraction (a batch behind one percent). Null for
   *  bus passes, whose fraction is derived from received/total. */
  percent: number | null;
  error: string | null;
  /** True while the owning command is in flight — the authoritative
   *  "this context is running" answer (ticks alone cannot say it: a queued or
   *  stalled pass emits none). */
  busy: boolean;
  /** Whether this context can be aborted at all — the registry says so, and
   *  the card renders its cancel action only when both this and `busy` hold
   *  (a batch write cannot be interrupted mid-flight). */
  cancellable: boolean;
  /** True once the user asked to cancel; the rejection is then expected and
   *  must not read as a failure. */
  cancelling: boolean;
  /** When the pass started (ms) — the card's mount-grace reference. */
  startedAt: number;
  /** Wall clock of the newest update (ms) — orders concurrent passes. */
  updatedAt: number;
}

/** The pass percentage a card renders, or null while it carries no fraction. */
export function passPercent(pass: ResourcePass | null): number | null {
  if (!pass) return null;
  if (pass.percent != null) return Math.min(100, Math.max(0, Math.round(pass.percent)));
  if (pass.phase !== "download" || pass.total <= 0) return null;
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

/** The phase verb a card shows when the owner supplies no step text. */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "queued":
      return t("settings.downloadQueued");
    case "race":
      return t("settings.downloadRacing");
    case "verify":
      return t("settings.downloadVerifying");
    case "download":
      return t("settings.downloadStreaming");
    case "apply":
    case "installing":
      return t("settings.downloadApplying");
    case "install":
      return t("settings.downloadInstalling");
    case "done":
      return t("settings.downloadFinished");
    case "error":
      return t("settings.downloadFailed");
    default:
      return t("settings.downloadStreaming");
  }
}

/** An owner's `report()` patch — every field optional so a store can push just
 *  what changed. */
export interface PassReport {
  phase?: string;
  label?: string;
  step?: string;
  received?: number;
  total?: number;
  speedBps?: number;
  segment?: number;
  segments?: number;
  percent?: number | null;
  error?: string | null;
}

export const useDownloadsStore = defineStore("downloads", () => {
  const toast = useToast();
  /** Pass ledger, keyed by kind. A plain object (Vue instruments mutations) so
   *  the card re-renders on every update. */
  const passes = ref<Record<string, ResourcePass>>({});
  /** Per-kind tick handlers, registered by owner-sourced contexts that need
   *  the RAW item ticks (a batch folds several artifacts behind one percent).
   *  The context stays the only transport subscriber; owners subscribe here,
   *  so there is still exactly ONE listener process-wide. */
  const tickHandlers = new Map<string, Set<(tick: DownloadProgress) => void>>();
  let wired = false;

  /** Subscribe an owner to its kind's raw ticks (owner-sourced contexts).
   *  Returns the detach. The handler runs AFTER the ledger fold, so an owner
   *  reporting its own numbers never fights the bus shape. */
  function onTick(kind: string, handler: (tick: DownloadProgress) => void): () => void {
    ensureWired();
    let set = tickHandlers.get(kind);
    if (!set) {
      set = new Set();
      tickHandlers.set(kind, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /** Wire the ONE bus registration this layer owns. Idempotent (the api
   *  module fans the transport listener out to every subscriber). */
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

  /** Fold one bus tick into its context's pass. Only `bus`-sourced contexts
   *  listen: an owner-driven batch computes its own overall number, and a tick
   *  for a context nobody raised is ignored (no ghost cards). */
  function noteTick(tick: DownloadProgress): void {
    const source = specFor(tick.kind)?.source ?? "bus";
    if (source === "owner") {
      // A batch owns its numbers; still forward the raw per-item tick so the
      // owner can fold it, but never touch the pass here.
      for (const handler of tickHandlers.get(tick.kind) ?? []) {
        try {
          handler(tick);
        } catch {
          // A throwing owner handler must not take the bus (and every other
          // context's progress) down with it.
        }
      }
      return;
    }
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

  /** Apply an owner-pushed patch to one pass. Owners are the only writers of
   *  their own numbers; the ledger stays the single source the card reads. */
  function report(kind: string, patch: PassReport): void {
    const current = passes.value[kind];
    if (!current) return;
    passes.value = {
      ...passes.value,
      [kind]: { ...current, ...patch, updatedAt: Date.now() },
    };
  }

  /** Raise (or reset) one context's pass. Headline/step default from the
   *  registry; an owner may override them through `report`. */
  function begin(kind: string, phase = "queued", patch: PassReport = {}): void {
    ensureWired();
    const now = Date.now();
    const label = patch.label ?? (specFor(kind)?.labelKey ? t(specFor(kind)!.labelKey!) : kind);
    passes.value = {
      ...passes.value,
      [kind]: {
        kind,
        phase: patch.phase ?? phase,
        label,
        step: patch.step ?? "",
        received: patch.received ?? 0,
        total: patch.total ?? 0,
        speedBps: patch.speedBps ?? 0,
        segment: patch.segment ?? 1,
        segments: patch.segments ?? 1,
        percent: patch.percent ?? null,
        error: patch.error ?? null,
        cancellable: specFor(kind)?.cancel != null,
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
   * value) so they can gate on it without a try/catch of their own.
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
        const label = passes.value[kind]?.label ?? kind;
        toast.success(t("settings.downloadDone", { label }));
      }
    }
    return { ok: error == null, value, error };
  }

  /** Abort one running pass through its registry cancel verb. */
  async function cancel(kind: string): Promise<void> {
    const current = passes.value[kind];
    if (!current || !current.busy || current.cancelling || !current.cancellable) return;
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

  /** True while the given context is in flight — every surface's button
   *  gating (one source of truth, never a phase heuristic). */
  function busyFor(kind: string): boolean {
    return passes.value[kind]?.busy ?? false;
  }

  /** The last failure of one context, kept for the owning card's inline
   *  retry hint (progress is the toast concern; a failure the user must act
   *  on stays beside the button that retries it). */
  function errorFor(kind: string): string | null {
    const pass = passes.value[kind];
    return pass && !pass.busy && pass.phase === "error" ? pass.error : null;
  }

  /** The localized resource name of one kind (the registry's labelKey). */
  function labelFor(kind: string): string {
    const key = specFor(kind)?.labelKey;
    return key ? t(key) : kind;
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
    onTick,
    begin,
    report,
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
