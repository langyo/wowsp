/**
 * useStaticReport tests — the 战报 modal's bounded-fetch host. Pins: the
 * stale-seq guard (only the newest perspective's answer lands), the read
 * watchdog (a stalled round trip surfaces an error instead of owning the
 * spinner forever — the #1863 rule the stream read got), the late-but-
 * current cached answer still upgrading the panel, and close() orphaning an
 * in-flight fetch. Same harness shape as useReplayPositions.test.ts.
 */
import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type StaticReport } from "@/api";
import { fakeAs } from "@/test-utils/fakes";
import { STATIC_REPORT_READ_TIMEOUT_MS, useStaticReport } from "./useStaticReport";

vi.mock("@/api", () => ({ api: { decisionStaticReport: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const report = (entityId: number): StaticReport => fakeAs<StaticReport>({ entityId });

function setup() {
  const scope = effectScope();
  const state = scope.run(() => useStaticReport())!;
  return { scope, ...state };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

/** Let every queued microtask run (the composable's await continuation is
 *  one hop behind the test's own await). */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("static report fetch host", () => {
  it("opens the modal and lands the perspective's answer", async () => {
    const pending = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport).mockReturnValue(pending.promise);
    const s = setup();
    void s.open("match.wowsreplay", null);
    expect(api.decisionStaticReport).toHaveBeenCalledExactlyOnceWith("match.wowsreplay", null);
    expect(s.showReport.value).toBe(true);
    expect(s.loading.value).toBe(true);
    pending.resolve(report(7));
    await flushMicrotasks();
    expect(s.report.value?.entityId).toBe(7);
    expect(s.loading.value).toBe(false);
    expect(s.error.value).toBeNull();
    s.scope.stop();
  });

  it("bounds the spinner on a stalled round trip and takes the late cached answer", async () => {
    vi.useFakeTimers();
    const pending = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport).mockReturnValue(pending.promise);
    const s = setup();
    void s.open("match.wowsreplay", null);
    expect(s.loading.value).toBe(true);
    vi.advanceTimersByTime(STATIC_REPORT_READ_TIMEOUT_MS);
    expect(s.loading.value).toBe(false);
    expect(s.error.value).toContain("timed out");
    // The seq was NOT orphaned by the expiry: the backend caches the scoring
    // pass, so the late answer still lands and clears the error face.
    pending.resolve(report(7));
    await flushMicrotasks();
    expect(s.report.value?.entityId).toBe(7);
    expect(s.error.value).toBeNull();
    expect(s.loading.value).toBe(false);
    s.scope.stop();
  });

  it("keeps only the newest perspective's answer", async () => {
    const old = deferred<StaticReport>();
    const latest = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    const s = setup();
    void s.open("match.wowsreplay", 1);
    void s.open("match.wowsreplay", 2);
    latest.resolve(report(2));
    await flushMicrotasks();
    expect(s.report.value?.entityId).toBe(2);
    old.resolve(report(1));
    await flushMicrotasks();
    expect(s.report.value?.entityId).toBe(2);
    s.scope.stop();
  });

  it("does not show an older failure on the newer fetch", async () => {
    const old = deferred<StaticReport>();
    const latest = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    const s = setup();
    void s.open("match.wowsreplay", 1);
    void s.open("match.wowsreplay", 2);
    latest.resolve(report(2));
    await flushMicrotasks();
    old.reject("stale decode error");
    await flushMicrotasks();
    expect(s.error.value).toBeNull();
    expect(s.report.value?.entityId).toBe(2);
    s.scope.stop();
  });

  it("closing the modal orphans an in-flight fetch", async () => {
    const pending = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport).mockReturnValue(pending.promise);
    const s = setup();
    void s.open("match.wowsreplay", null);
    s.close();
    expect(s.showReport.value).toBe(false);
    expect(s.loading.value).toBe(false);
    pending.resolve(report(7));
    await flushMicrotasks();
    expect(s.report.value).toBeNull();
    s.scope.stop();
  });

  it("surfaces a rejection as the error face", async () => {
    const pending = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport).mockReturnValue(pending.promise);
    const s = setup();
    void s.open("match.wowsreplay", null);
    pending.reject("report boom");
    await flushMicrotasks();
    expect(s.loading.value).toBe(false);
    expect(s.error.value).toContain("report boom");
    expect(s.report.value).toBeNull();
    s.scope.stop();
  });

  it("arms a fresh watchdog for a perspective opened after a timeout", async () => {
    vi.useFakeTimers();
    const first = deferred<StaticReport>();
    const second = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const s = setup();
    void s.open("match.wowsreplay", 1);
    vi.advanceTimersByTime(STATIC_REPORT_READ_TIMEOUT_MS);
    expect(s.error.value).toContain("timed out");
    // A perspective pick re-opens with a clean face and its own budget.
    void s.open("match.wowsreplay", 2);
    expect(s.loading.value).toBe(true);
    expect(s.error.value).toBeNull();
    vi.advanceTimersByTime(STATIC_REPORT_READ_TIMEOUT_MS - 1);
    expect(s.loading.value).toBe(true);
    second.resolve(report(2));
    await flushMicrotasks();
    expect(s.report.value?.entityId).toBe(2);
    expect(s.error.value).toBeNull();
    s.scope.stop();
  });
});
