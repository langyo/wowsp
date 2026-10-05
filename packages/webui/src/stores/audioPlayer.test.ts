/** audioPlayer store: the play/toggle/supersede lifecycle of preview
 *  audio and its sticky stock-toast surface (loading toast while a
 *  track rolls, gone on pause/stop), driven through a stub
 *  HTMLAudioElement swapped in via the factory seam. */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useToast } from "@celestia-island/hikari";

import { setAudioElementFactoryForTests, useAudioPlayerStore } from "./audioPlayer";

type Handler = ((e: Event) => unknown) | null;

/** Just the surface the store touches, cast to HTMLAudioElement. */
class StubAudioElement {
  src = "";
  paused = true;
  error: { message: string } | null = null;
  onplay: Handler = null;
  onpause: Handler = null;
  onended: Handler = null;
  onerror: Handler = null;
  play = vi.fn(async () => {
    this.paused = false;
    this.onplay?.(new Event("play"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.onpause?.(new Event("pause"));
  });
  removeAttribute = vi.fn();
  load = vi.fn();
}

let el: StubAudioElement;

beforeEach(() => {
  setActivePinia(createPinia());
  el = new StubAudioElement();
  setAudioElementFactoryForTests(() => el as unknown as HTMLAudioElement);
});

afterEach(() => {
  setAudioElementFactoryForTests(() => new Audio());
  // hikari's toast slots are module-global while every test gets a
  // fresh pinia — clear through hikari's own remove() (the way its
  // upstream tests do; it also drops pending auto-dismiss timers).
  for (const slot of [...useToast().toasts]) {
    useToast().remove(slot.id);
  }
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The sticky playing toast — hikari keeps one loading slot; its stack
 *  holds the current message. */
function playingToast(): boolean {
  const slot = useToast().toasts.find((s) => s.type === "loading");
  return !!slot && slot.messages.length > 0;
}

describe("useAudioPlayerStore", () => {
  it("plays a new track through the loader and raises the sticky toast", async () => {
    const player = useAudioPlayerStore();
    expect(player.active).toBe(false);
    expect(playingToast()).toBe(false);

    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    expect(el.src).toBe("data:audio/wav;base64,QQ");
    expect(el.play).toHaveBeenCalled();
    expect(player.active).toBe(true);
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(true);
    expect(playingToast()).toBe(true);
  });

  it("re-asking the same track toggles pause/resume with the toast", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");

    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    expect(player.playing).toBe(false);
    expect(playingToast()).toBe(false);

    el.play.mockClear();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    expect(el.play).toHaveBeenCalled();
    expect(player.playing).toBe(true);
    expect(playingToast()).toBe(true);
  });

  it("supersedes a slow loader: the stale result never reaches the element", async () => {
    const player = useAudioPlayerStore();
    const slow = deferred<string>();
    const first = player.play("banks/slow.wem", "slow.wem", () => slow.promise);
    await player.play("banks/fast.wem", "fast.wem", async () => "data:audio/wav;base64,Rg");
    expect(el.src).toBe("data:audio/wav;base64,Rg");
    expect(player.rel).toBe("banks/fast.wem");

    slow.resolve("data:audio/wav;base64,Uw");
    await first;
    expect(el.src).toBe("data:audio/wav;base64,Rg");
    expect(player.loading).toBe(false);
  });

  it("stop() during an in-flight loader discards its result silently", async () => {
    const player = useAudioPlayerStore();
    const pending = deferred<string>();
    const started = player.play("banks/slow.wem", "slow.wem", () => pending.promise);
    player.stop();
    expect(player.active).toBe(false);

    pending.resolve("data:audio/wav;base64,Uw");
    await started;
    expect(el.src).toBe("");
    expect(player.loading).toBe(false);
    expect(playingToast()).toBe(false);
  });

  it("stop() tears the element down and drops the toast", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    expect(playingToast()).toBe(true);
    player.stop();
    expect(player.active).toBe(false);
    expect(player.rel).toBe("");
    expect(el.pause).toHaveBeenCalled();
    expect(el.load).toHaveBeenCalled();
    expect(el.onended).toBeNull();
    expect(el.onerror).toBeNull();
    expect(playingToast()).toBe(false);
  });

  it("natural end closes the session and the toast", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    el.onended?.(new Event("ended"));
    expect(player.active).toBe(false);
    expect(playingToast()).toBe(false);
  });

  it("a same-rel retry after a stop never arms the orphaned element", async () => {
    const player = useAudioPlayerStore();
    const first = deferred<string>();
    const started = player.play("banks/a.wem", "a.wem", () => first.promise);
    const orphan = el; // the element the stale loader captured
    player.stop(); // swap tears the wired element down (el = null)
    el = new StubAudioElement(); // the retry creates a fresh element
    setAudioElementFactoryForTests(() => el as unknown as HTMLAudioElement);

    const second = deferred<string>();
    const retried = player.play("banks/a.wem", "a.wem", () => second.promise);
    first.resolve("data:audio/wav;base64,QQ");
    await started;
    // The FIRST (stale) loader passed the rel guard in the old code and
    // armed THIS orphan — the session token must kill it before the src
    // assignment, and the pending retry keeps loading.
    expect(orphan.src).toBe("");
    expect(orphan.play).not.toHaveBeenCalled();
    expect(player.loading).toBe(true);

    second.resolve("data:audio/wav;base64,Rg");
    await retried;
    expect(el.src).toBe("data:audio/wav;base64,Rg");
    expect(player.playing).toBe(true);
    expect(orphan.play).not.toHaveBeenCalled();
  });

  it("a failed load raises an error toast and resets", async () => {
    const player = useAudioPlayerStore();
    const slot = () => useToast().toasts.find((s) => s.type === "error");
    const before = slot()?.messages.length ?? 0;
    await player.play("banks/bad.wem", "bad.wem", async () => {
      throw new Error("decode boom");
    });
    expect(player.active).toBe(false);
    expect(playingToast()).toBe(false);
    expect(slot()?.messages.length).toBe(before + 1);
    expect(slot()?.messages.at(-1)?.text).toContain("decode boom");
  });

  it("a decode error during playback raises a toast and stops", async () => {
    const player = useAudioPlayerStore();
    const slot = () => useToast().toasts.find((s) => s.type === "error");
    const before = slot()?.messages.length ?? 0;
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    el.error = { message: "unsupported codec" };
    el.onerror?.(new Event("error"));
    expect(player.active).toBe(false);
    expect(playingToast()).toBe(false);
    expect(slot()?.messages.length).toBe(before + 1);
  });
});
