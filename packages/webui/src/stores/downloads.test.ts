/**
 * The unified download context (stores/downloads).
 *
 * These tests pin the layer ABOVE the transport bus — the contract every
 * resource download now shares:
 *
 * - ONE registry declares how each kind is presented, so a new resource
 *   cannot grow a private progress surface again;
 * - ONE ledger answers "is this running?" (`busyFor`) and folds the bus ticks
 *   into that pass, so the settings cards and the shared card cannot disagree;
 * - ONE lifecycle (`track`) raises, records and settles a pass, keeps a user
 *   cancel neutral, and turns the two invisible outcomes (failure, an instant
 *   success inside the card's mount grace) into toasts;
 * - ONE presentation decision: resource passes render on the shared top-right
 *   card, never inline in the settings pane.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useToast } from "@celestia-island/hikari";

import type { DownloadProgress } from "@/api";
import { initLocaleMessages } from "@/i18n";
import {
  DOWNLOAD_CARD_GRACE_MS,
  DOWNLOAD_CONTEXTS,
  passPercent,
  useDownloadsStore,
} from "@/stores/downloads";

const mocks = vi.hoisted(() => ({
  resCancel: vi.fn(),
  aiPackCancel: vi.fn(),
  listenDownloadProgress: vi.fn((_handler: (p: DownloadProgress) => void) => () => undefined),
}));

vi.mock("@/api", () => ({ api: mocks }));

/** The tick shape the Rust hub emits. */
function tick(kind: string, phase: string, over: Partial<DownloadProgress> = {}): DownloadProgress {
  return {
    id: kind,
    kind,
    phase,
    received: 0,
    total: 0,
    speedBps: 0,
    detail: null,
    error: null,
    ...over,
  };
}

/** Every toast text on screen (the store's announcements ride this). */
function toastTexts(): string[] {
  return useToast().toasts.flatMap((slot) => slot.messages.map((msg) => msg.text));
}

// The store's announcements are localized; the assertions compare against the
// SAME message tables the app renders.
beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  for (const slot of [...useToast().toasts]) useToast().remove(slot.id);
});

afterEach(() => {
  for (const slot of [...useToast().toasts]) useToast().remove(slot.id);
});

describe("the download context registry", () => {
  it("covers every bus kind exactly once", () => {
    const kinds = DOWNLOAD_CONTEXTS.map((spec) => spec.kind);
    // The producer contract lives in wowsp_tauri_shared::download::kind — every
    // one of its kinds must have a presentation row here, or its pass would
    // render nowhere.
    expect(kinds).toEqual(["update", "res-pack", "ai-models", "data-pack", "mod-package"]);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("gives every card context a localized label", () => {
    for (const spec of DOWNLOAD_CONTEXTS.filter((s) => s.presentation === "card")) {
      // A card context with no label would render a raw bus kind.
      expect(spec.labelKey, spec.kind).toBeTruthy();
    }
  });

  it("declares a cancel verb for every abortable context", () => {
    // The batch (mod catalog installs write their tree atomically) and the
    // boot-time data lane cannot be aborted; everything else must be, or a
    // 1.2 GB pass would have no way out.
    const abortable = DOWNLOAD_CONTEXTS.filter((s) => s.kind !== "mod-package" && s.kind !== "data-pack");
    for (const spec of abortable) {
      expect(spec.cancel, spec.kind).toBeTypeOf("function");
    }
  });

  it("keeps the boot-time data lane silent", () => {
    expect(DOWNLOAD_CONTEXTS.find((s) => s.kind === "data-pack")?.presentation).toBe("silent");
  });

  it("routes the batch through the owner source", () => {
    // A batch puts several artifacts behind ONE percent, so a raw per-file
    // tick can never be the card's number.
    expect(DOWNLOAD_CONTEXTS.find((s) => s.kind === "mod-package")?.source).toBe("owner");
  });
});

describe("pass ledger", () => {
  it("folds bus ticks into the pass raised by the owner", () => {
    const downloads = useDownloadsStore();
    downloads.ensureWired();
    const handler = mocks.listenDownloadProgress.mock.calls[0][0];

    downloads.begin("res-pack");
    expect(downloads.busyFor("res-pack")).toBe(true);

    handler(
      tick("res-pack", "download", {
        received: 512,
        total: 1024,
        speedBps: 2048,
        detail: { segment: 2, segments: 3 },
      }),
    );

    const pass = downloads.passFor("res-pack");
    expect(pass?.phase).toBe("download");
    expect(pass?.speedBps).toBe(2048);
    expect(pass?.segment).toBe(2);
    expect(pass?.segments).toBe(3);
    expect(passPercent(pass)).toBe(50);
  });

  it("ignores ticks for a context the owner never raised", () => {
    const downloads = useDownloadsStore();
    downloads.ensureWired();
    const handler = mocks.listenDownloadProgress.mock.calls[0][0];
    // A producer emitting without a tracked pass must not paint a ghost card.
    handler(tick("res-pack", "download", { received: 1, total: 2 }));
    expect(downloads.passFor("res-pack")).toBeNull();
    expect(downloads.running).toBe(false);
  });

  it("drops the transfer rate outside the download phase", () => {
    const downloads = useDownloadsStore();
    downloads.ensureWired();
    const handler = mocks.listenDownloadProgress.mock.calls[0][0];
    downloads.begin("res-pack");
    handler(tick("res-pack", "download", { received: 1, total: 2, speedBps: 4096 }));
    expect(downloads.passFor("res-pack")?.speedBps).toBe(4096);
    // Applying is not streaming — a rate must not outlive its byte stream.
    handler(tick("res-pack", "apply", { received: 2, total: 2, speedBps: 4096 }));
    expect(downloads.passFor("res-pack")?.speedBps).toBe(0);
  });

  it("reports no percent while the phase carries no fraction", () => {
    const downloads = useDownloadsStore();
    downloads.begin("ai-models");
    expect(passPercent(downloads.passFor("ai-models"))).toBeNull();
  });
});

describe("track lifecycle", () => {
  it("settles a successful pass and keeps it for the card's fold-out", async () => {
    const downloads = useDownloadsStore();
    const { ok } = await downloads.track("res-pack", async () => {
      expect(downloads.busyFor("res-pack")).toBe(true);
    });
    expect(ok).toBe(true);
    expect(downloads.busyFor("res-pack")).toBe(false);
    expect(downloads.passFor("res-pack")?.phase).toBe("done");
    expect(downloads.running).toBe(false);
  });

  it("records a failure on the pass, returns it, and raises an error toast", async () => {
    const downloads = useDownloadsStore();
    const outcome = await downloads.track("ai-models", async () => {
      throw new Error("no endpoint candidate");
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("no endpoint candidate");
    expect(downloads.errorFor("ai-models")).toBe("no endpoint candidate");
    expect(downloads.busyFor("ai-models")).toBe(false);
    // The card folds out on the error; a toast carries the reason because a
    // folded card cannot be read.
    expect(toastTexts().some((text) => text.includes("no endpoint candidate"))).toBe(true);
  });

  it("does not rethrow — the owning store still refreshes its state", async () => {
    const downloads = useDownloadsStore();
    await expect(
      downloads.track("res-pack", async () => {
        throw new Error("busy");
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("keeps a requested cancel neutral", async () => {
    const downloads = useDownloadsStore();
    let reject!: (e: Error) => void;
    const pass = downloads.track(
      "res-pack",
      () => new Promise<void>((_resolve, rej) => { reject = rej; }),
    );
    await downloads.cancel("res-pack");
    expect(mocks.resCancel).toHaveBeenCalledTimes(1);
    reject(new Error("resource pack download cancelled"));
    const outcome = await pass;
    // The user asked for it: no failure, no error toast.
    expect(outcome.ok).toBe(true);
    expect(downloads.errorFor("res-pack")).toBeNull();
    expect(downloads.passFor("res-pack")?.phase).toBe("done");
    expect(toastTexts().some((text) => text.includes("cancelled"))).toBe(false);
  });

  it("announces an instant success that never mounted the card", async () => {
    const downloads = useDownloadsStore();
    await downloads.track("res-pack", async () => undefined);
    // The pass landed inside the mount grace, so the card never appeared —
    // without this toast the click would read as a no-op.
    expect(toastTexts()).toHaveLength(1);
    expect(toastTexts()[0]).toContain("Resource pack");
  });

  it("raises a card pass without announcing anything while it runs", async () => {
    const downloads = useDownloadsStore();
    let release!: () => void;
    const pass = downloads.track(
      "ai-models",
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    expect(toastTexts()).toHaveLength(0);
    expect(downloads.running).toBe(true);
    release();
    await pass;
    expect(downloads.running).toBe(false);
  });
});

describe("shared card presentation", () => {
  it("prefers the live pass over a settled one", async () => {
    const downloads = useDownloadsStore();
    await downloads.track("res-pack", async () => undefined);
    downloads.begin("ai-models");
    expect(downloads.cardPass?.kind).toBe("ai-models");
    expect(downloads.running).toBe(true);
  });

  it("never presents a silent context on the shared card", () => {
    const downloads = useDownloadsStore();
    downloads.begin("data-pack");
    // The boot-time lane has no card of its own — and must not borrow the
    // shared one either (a card would flash on every launch).
    expect(downloads.cardPass).toBeNull();
    expect(downloads.running).toBe(false);
  });

  it("presents an owner-driven batch on the same card", () => {
    const downloads = useDownloadsStore();
    downloads.begin("mod-package", "download", { step: "mod-a (1/3)" });
    downloads.report("mod-package", { percent: 50 });
    expect(downloads.cardPass?.kind).toBe("mod-package");
    expect(downloads.cardPass?.step).toBe("mod-a (1/3)");
    expect(passPercent(downloads.cardPass)).toBe(50);
  });

  it("forwards raw ticks to an owner without touching its pass", () => {
    const downloads = useDownloadsStore();
    const seen: string[] = [];
    const off = downloads.onTick("mod-package", (tick) => seen.push(tick.phase));
    downloads.begin("mod-package");
    downloads.report("mod-package", { percent: 42 });
    const handler = mocks.listenDownloadProgress.mock.calls[0][0];
    handler(tick("mod-package", "download", { received: 1, total: 2 }));
    expect(seen).toEqual(["download"]);
    // The owner's number survives: a batch percent is not a per-file percent.
    expect(passPercent(downloads.passFor("mod-package"))).toBe(42);
    off();
    handler(tick("mod-package", "installing"));
    expect(seen).toEqual(["download"]);
  });

  it("keeps the mount grace a real delay", () => {
    // The card's grace and the store's announcement decision share this value;
    // zeroing it would let every instant pass flash a card.
    expect(DOWNLOAD_CARD_GRACE_MS).toBeGreaterThan(0);
  });
});

describe("cancel", () => {
  it("goes through the registry verb of the addressed context", async () => {
    const downloads = useDownloadsStore();
    downloads.begin("ai-models");
    await downloads.cancel("ai-models");
    expect(mocks.aiPackCancel).toHaveBeenCalledTimes(1);
    expect(mocks.resCancel).not.toHaveBeenCalled();
  });

  it("is a no-op while nothing runs (no stray command)", async () => {
    const downloads = useDownloadsStore();
    await downloads.cancel("res-pack");
    expect(mocks.resCancel).not.toHaveBeenCalled();
  });

  it("does not double-fire a second cancel request", async () => {
    const downloads = useDownloadsStore();
    downloads.begin("res-pack");
    await downloads.cancel("res-pack");
    await downloads.cancel("res-pack");
    expect(mocks.resCancel).toHaveBeenCalledTimes(1);
  });
});

describe("clear", () => {
  it("drops a settled pass but never a running one", async () => {
    const downloads = useDownloadsStore();
    await downloads.track("res-pack", async () => undefined);
    downloads.clear("res-pack");
    expect(downloads.passFor("res-pack")).toBeNull();

    downloads.begin("res-pack");
    downloads.clear("res-pack");
    expect(downloads.passFor("res-pack")).not.toBeNull();
  });
});
