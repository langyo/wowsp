/** audioPlayer store: the toggle/supersede/seek lifecycle of the preview
 *  audio controller, driven through a stub HTMLAudioElement swapped in
 *  via the factory seam (the same code path the app drives a real
 *  element). */
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
  ontimeupdate: Handler = null;
  ondurationchange: Handler = null;
  onplay: Handler = null;
  onpause: Handler = null;
  onended: Handler = null;
  onerror: Handler = null;
  #duration = Number.NaN;
  #currentTime = 0;
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

  get duration(): number {
    return this.#duration;
  }

  set duration(v: number) {
    this.#duration = v;
    this.ondurationchange?.(new Event("durationchange"));
  }

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(v: number) {
    this.#currentTime = v;
    this.ontimeupdate?.(new Event("timeupdate"));
  }

  /** Advance the clock the way rolling playback would — WITHOUT firing
   *  timeupdate, so the frame ticker is the only position source. */
  advance(t: number) {
    this.#currentTime = t;
  }
}

let el: StubAudioElement;

beforeEach(() => {
  setActivePinia(createPinia());
  el = new StubAudioElement();
  setAudioElementFactoryForTests(() => el as unknown as HTMLAudioElement);
  // The store's frame ticker would otherwise spin real happy-dom rAF
  // loops for the rest of the file (tests end with tracks still
  // playing); frames are never needed here — the ticker test installs
  // its own manual capture on top of this stub.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAudioElementFactoryForTests(() => new Audio());
  // hikari's toast slots are module-global while every test gets a
  // fresh pinia — clear through hikari's own remove() (it also drops
  // pending auto-dismiss timers).
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

describe("useAudioPlayerStore", () => {
  it("plays a new track through the loader and follows element state", async () => {
    const player = useAudioPlayerStore();
    expect(player.active).toBe(false);

    const started = player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    expect(player.active).toBe(true);
    expect(player.loading).toBe(true);
    expect(player.title).toBe("a.wem");
    await started;
    expect(el.src).toBe("data:audio/wav;base64,QQ");
    expect(el.play).toHaveBeenCalled();
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(true);
    expect(player.rel).toBe("banks/a.wem");
  });

  it("picks the duration up from the element", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    el.duration = 12.5;
    expect(player.duration).toBeCloseTo(12.5);
  });

  it("drives position per animation frame while rolling", async () => {
    // Manual frames: capture the pending callback, flush on demand.
    let frame: FrameRequestCallback | undefined;
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        frame = cb;
        return 1;
      });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    try {
      const player = useAudioPlayerStore();
      await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
      expect(raf).toHaveBeenCalled(); // ticker started on play
      expect(frame).toBeDefined();

      // The element clock moves without a timeupdate (rolling playback,
      // not a seek): only the ticker can surface the new position.
      el.advance(3.25);
      expect(player.position).toBe(0);
      frame!(0);
      expect(player.position).toBeCloseTo(3.25);

      // Pausing cancels the loop; a stale frame must no-op.
      el.pause();
      expect(cancel).toHaveBeenCalled();
      const settled = player.position;
      el.advance(9);
      frame?.(0);
      expect(player.position).toBeCloseTo(settled);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
    }
  });

  it("re-asking the same track toggles pause and resume", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    el.pause.mockClear();

    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    expect(el.pause).toHaveBeenCalled();
    expect(player.playing).toBe(false);

    el.play.mockClear();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    expect(el.play).toHaveBeenCalled();
    expect(player.playing).toBe(true);
  });

  it("supersedes a slow loader: the stale result never reaches the element", async () => {
    const player = useAudioPlayerStore();
    const slow = deferred<string>();
    const first = player.play("banks/slow.wem", "slow.wem", () => slow.promise);
    await player.play("banks/fast.wem", "fast.wem", async () => "data:audio/wav;base64,Rg");
    expect(el.src).toBe("data:audio/wav;base64,Rg");

    slow.resolve("data:audio/wav;base64,Uw");
    await first;
    expect(el.src).toBe("data:audio/wav;base64,Rg");
    expect(player.rel).toBe("banks/fast.wem");
    expect(player.loading).toBe(false);
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

  it("seeks by ratio and clamps to the track", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    el.duration = 10;
    player.seekRatio(0.5);
    expect(el.currentTime).toBeCloseTo(5);
    expect(player.position).toBeCloseTo(5);
    player.seek(999);
    expect(el.currentTime).toBeCloseTo(10);
    player.seek(-1);
    expect(el.currentTime).toBeCloseTo(0);
  });

  it("toggle and seek are no-ops while a track is loading", async () => {
    const player = useAudioPlayerStore();
    const pending = deferred<string>();
    const started = player.play("banks/slow.wem", "slow.wem", () => pending.promise);
    // play() itself pauses the fresh element at swap time — clear that
    // call so the assertions see only what toggle/seek do.
    el.play.mockClear();
    el.pause.mockClear();
    player.togglePlayPause();
    player.seekRatio(0.9);
    expect(el.play).not.toHaveBeenCalled();
    expect(el.pause).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(0);

    pending.resolve("data:audio/wav;base64,QQ");
    await started;
    expect(player.playing).toBe(true);
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
  });

  it("stop() tears the element down and closes the card", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    player.stop();
    expect(player.active).toBe(false);
    expect(player.rel).toBe("");
    expect(el.pause).toHaveBeenCalled();
    expect(el.load).toHaveBeenCalled();
    expect(el.onended).toBeNull();
    expect(el.onerror).toBeNull();
  });

  it("natural end closes the card", async () => {
    const player = useAudioPlayerStore();
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    el.onended?.(new Event("ended"));
    expect(player.active).toBe(false);
  });

  it("a failed load raises an error toast and resets", async () => {
    const player = useAudioPlayerStore();
    // Errors share one hikari slot — assert on the slot's stack growth,
    // not on the slot count (earlier tests may have opened it).
    const slot = () => useToast().toasts.find((t) => t.type === "error");
    const before = slot()?.messages.length ?? 0;
    await player.play("banks/bad.wem", "bad.wem", async () => {
      throw new Error("decode boom");
    });
    expect(player.active).toBe(false);
    expect(slot()?.messages.length).toBe(before + 1);
    expect(slot()?.messages.at(-1)?.text).toContain("decode boom");
  });

  it("a decode error during playback raises a toast and stops", async () => {
    const player = useAudioPlayerStore();
    const slot = () => useToast().toasts.find((t) => t.type === "error");
    const before = slot()?.messages.length ?? 0;
    await player.play("banks/a.wem", "a.wem", async () => "data:audio/wav;base64,QQ");
    el.error = { message: "unsupported codec" };
    el.onerror?.(new Event("error"));
    expect(player.active).toBe(false);
    expect(slot()?.messages.length).toBe(before + 1);
  });
});
