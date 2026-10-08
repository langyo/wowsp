import { effectScope, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ReplayMeta, type ReplayStream } from "@/api";
import { useReplayPositions } from "./useReplayPositions";

vi.mock("@/api", () => ({ api: { readReplayPositions: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const meta = (path: string): ReplayMeta => ({ path, vehicles: [], raw: {} });
const stream = { trajectories: [] } as unknown as ReplayStream;

function setup(initial: ReplayMeta | null = null) {
  const current = ref<ReplayMeta | null>(initial);
  const handlers = { reset: vi.fn(), apply: vi.fn() };
  const scope = effectScope();
  const state = scope.run(() => useReplayPositions(current, handlers))!;
  return { current, handlers, scope, ...state };
}

beforeEach(() => vi.resetAllMocks());

describe("replay packet requests", () => {
  it("decodes the retained selection when the replay view mounts again", async () => {
    const pending = deferred<ReplayStream>();
    vi.mocked(api.readReplayPositions).mockReturnValue(pending.promise);
    const s = setup(meta("retained"));
    expect(api.readReplayPositions).toHaveBeenCalledExactlyOnceWith("retained");
    expect(s.loading.value).toBe(true);
    pending.resolve(stream);
    await pending.promise;
    expect(s.handlers.apply).toHaveBeenCalledExactlyOnceWith(stream, meta("retained"));
    expect(s.loading.value).toBe(false);
    s.scope.stop();
  });

  it("does not finish a newer loading indicator when an older decode succeeds", async () => {
    const old = deferred<ReplayStream>();
    const latest = deferred<ReplayStream>();
    vi.mocked(api.readReplayPositions).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const s = setup();
    s.current.value = meta("old");
    s.current.value = meta("latest");
    old.resolve(stream);
    await old.promise;
    expect(s.loading.value).toBe(true);
    expect(s.handlers.apply).not.toHaveBeenCalled();
    latest.resolve(stream);
    await latest.promise;
    expect(s.handlers.apply).toHaveBeenCalledExactlyOnceWith(stream, meta("latest"));
    expect(s.loading.value).toBe(false);
    s.scope.stop();
  });

  it("does not show an older failure on the newly loaded replay", async () => {
    const old = deferred<ReplayStream>();
    const latest = deferred<ReplayStream>();
    vi.mocked(api.readReplayPositions).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const s = setup();
    s.current.value = meta("old");
    s.current.value = meta("latest");
    latest.resolve(stream);
    await latest.promise;
    old.reject("stale decode error");
    await old.promise.catch(() => {});
    expect(s.error.value).toBeNull();
    expect(s.handlers.apply).toHaveBeenCalledTimes(1);
    s.scope.stop();
  });

  it("distinguishes reopening the same path from its old in-flight request", async () => {
    const old = deferred<ReplayStream>();
    const reopened = deferred<ReplayStream>();
    vi.mocked(api.readReplayPositions).mockReturnValueOnce(old.promise).mockReturnValueOnce(reopened.promise);
    const s = setup();
    s.current.value = meta("same");
    s.current.value = null;
    s.current.value = meta("same");
    old.resolve(stream);
    await old.promise;
    expect(s.handlers.apply).not.toHaveBeenCalled();
    expect(s.loading.value).toBe(true);
    reopened.resolve(stream);
    await reopened.promise;
    expect(s.handlers.apply).toHaveBeenCalledTimes(1);
    s.scope.stop();
  });

  it("resets display data and loading when a selection is cleared", async () => {
    const pending = deferred<ReplayStream>();
    vi.mocked(api.readReplayPositions).mockReturnValue(pending.promise);
    const s = setup();
    s.current.value = meta("closed");
    s.current.value = null;
    expect(s.loading.value).toBe(false);
    expect(s.handlers.reset).toHaveBeenCalledTimes(3);
    pending.resolve(stream);
    await pending.promise;
    expect(s.handlers.apply).not.toHaveBeenCalled();
    s.scope.stop();
  });

  it("does not publish after the replay view is unmounted", async () => {
    const pending = deferred<ReplayStream>();
    vi.mocked(api.readReplayPositions).mockReturnValue(pending.promise);
    const s = setup();
    s.current.value = meta("closed");
    s.scope.stop();
    pending.resolve(stream);
    await pending.promise;
    expect(s.handlers.apply).not.toHaveBeenCalled();
  });

  it("shows current native command errors as strings", async () => {
    const pending = deferred<ReplayStream>();
    vi.mocked(api.readReplayPositions).mockReturnValue(pending.promise);
    const s = setup();
    s.current.value = meta("broken");
    pending.reject("invalid compressed packet");
    await pending.promise.catch(() => {});
    expect(s.error.value).toBe("invalid compressed packet");
    expect(s.loading.value).toBe(false);
    s.scope.stop();
  });
});
