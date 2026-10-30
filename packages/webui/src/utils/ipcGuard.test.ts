/**
 * Tests for the startup IPC guard: a hung channel raises the reload
 * notice, a channel that ANSWERS WITH AN ERROR is healthy (no notice),
 * a non-Tauri shell never probes, and the notice removes itself once the
 * channel recovers.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { initLocaleMessages } from "@/i18n";
import { ipcChannelAnswers, startIpcGuard } from "./ipcGuard";

const NOTICE_ID = "wowsp-ipc-guard";

beforeAll(async () => {
  await initLocaleMessages();
});

afterEach(() => {
  vi.useRealTimers();
  document.getElementById(NOTICE_ID)?.remove();
});

describe("ipcChannelAnswers", () => {
  it("a rejection still counts as answered (the channel works)", async () => {
    expect(await ipcChannelAnswers(() => Promise.reject(new Error("rpc says no")))).toBe(true);
  });

  it("a silent channel counts as hung", async () => {
    vi.useFakeTimers();
    const probe = ipcChannelAnswers(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await probe).toBe(false);
  });

  it("a slowly-answering channel counts as answered", async () => {
    vi.useFakeTimers();
    const probe = ipcChannelAnswers(
      () => new Promise((resolve) => window.setTimeout(() => resolve(1), 1_000)),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await probe).toBe(true);
  });
});

describe("startIpcGuard", () => {
  it("does nothing outside the Tauri shell", async () => {
    const probe = vi.fn(() => Promise.resolve(1));
    await startIpcGuard({ probe, isShell: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("raises the notice on a hung channel and clears it on recovery", async () => {
    vi.useFakeTimers();
    let answers = false;
    const probe = () =>
      answers ? Promise.resolve("v0") : new Promise<unknown>(() => undefined);

    const guard = startIpcGuard({ probe, isShell: true });
    await vi.advanceTimersByTimeAsync(4_000);
    await guard;
    expect(document.getElementById(NOTICE_ID)).not.toBeNull();

    answers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.getElementById(NOTICE_ID)).toBeNull();
  });

  it("raises no notice when the channel answers", async () => {
    const guard = startIpcGuard({ probe: () => Promise.resolve("v0"), isShell: true });
    await guard;
    expect(document.getElementById(NOTICE_ID)).toBeNull();
  });
});
