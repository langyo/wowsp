/**
 * Page-level regression for the battle-chat translation card, driven the way
 * production drives it: the real chat.ts bootstrap against a mocked
 * `window.__TAURI__`, then the bridge's two events.
 *
 * Pins the card's buffer contract (chat.ts): the window keeps only the
 * newest `maxLines` lines, a DIFFERENT battle id clears everything first, a
 * re-emitted line id is ignored, the cap follows `wowsp://chat-prefs` live,
 * every row carries its translation's `lang`, the body is drawn with
 * `textContent` (arbitrary chat input — any markup stays literal), and an
 * empty buffer renders NO nodes at all (the window is fully transparent).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();
let battleSeq = 0;
/** The battle id the current test's same-battle events carry. */
let currentBattle = "";

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".chat-panel");
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(".chat-panel__line"),
];
const rowTexts = (): string[] =>
  rows().map((r) => r.querySelector(".chat-panel__text")?.textContent ?? "");

function emit(event: string, payload: unknown) {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no listener for ${event}`);
  handler({ payload });
}

/** Allocate a battle id that no other call has seen — the id is the
 *  bridge's battle key, so tests must never reuse one. */
function newBattle(): string {
  battleSeq += 1;
  return `battle-${battleSeq}`;
}

/** Give the next test a fresh battle (an empty snapshot of a NEW id clears
 *  both the buffer and any previously attached panel). */
function resetBattle() {
  currentBattle = newBattle();
  emit("wowsp://chat-translate", {
    battle: currentBattle,
    lines: [],
    maxLines: 8,
  });
}

beforeAll(async () => {
  vi.stubGlobal("__TAURI__", {
    event: {
      listen: vi.fn(async (ev: string, h: Handler) => {
        handlers.set(ev, h);
        return () => handlers.delete(ev);
      }),
    },
  });
  await import("./chat");
  await vi.waitFor(() => {
    expect(handlers.has("wowsp://chat-translate")).toBe(true);
    expect(handlers.has("wowsp://chat-prefs")).toBe(true);
  });
  // The card's accessible name + window title come from overlay.json's
  // overlay.chat.title (the default locale is en-US — no ?locale param).
  await vi.waitFor(() => expect(document.title).toBe("Chat translation"));
});

beforeEach(() => {
  resetBattle();
});

describe("chat translation card", () => {
  it("renders no nodes at all before the first line", () => {
    expect(panel()).toBeNull();
    expect(rows().length).toBe(0);
    expect(document.body.textContent).toBe("");
  });

  it("keeps the newest lines only and stamps each row's language", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 2,
      lines: [
        { id: 1, from: "one", lang: "ja", translated: "一" },
        { id: 2, from: "two", lang: "ko", translated: "이" },
        { id: 3, from: "three", lang: "zh-TW", translated: "三" },
      ],
    });
    expect(rowTexts()).toEqual(["이", "三"]);
    expect(rows().map((r) => r.getAttribute("lang"))).toEqual(["ko", "zh-TW"]);
    // The sender rides its own muted cell ahead of the body.
    expect(rows()[0].querySelector(".chat-panel__from")?.textContent).toBe("two");
    expect(panel()?.getAttribute("role")).toBe("log");
    expect(panel()?.getAttribute("aria-label")).toBe("Chat translation");
  });

  it("clears the buffer when the battle id changes", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 8,
      lines: [{ id: 1, from: "old", lang: "ja", translated: "前の戦闘" }],
    });
    expect(rowTexts()).toEqual(["前の戦闘"]);
    // A new battle's first line — the finished battle's line must not leak.
    emit("wowsp://chat-translate", {
      battle: newBattle(),
      maxLines: 8,
      lines: [{ id: 1, from: "new", lang: "ko", translated: "새 전투" }],
    });
    expect(rowTexts()).toEqual(["새 전투"]);
    expect(panel()?.querySelector(".chat-panel__from")?.textContent).toBe("new");
  });

  it("draws chat input literally and falls back to the original text", () => {
    const hostile = '<img src=x onerror="alert(1)"><b>bold</b>';
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [
        { id: 1, lang: "en", text: "original", translated: hostile },
        // Pending translation — the original body still reads.
        { id: 2, from: "muted", lang: "ja", text: "原文", translated: "" },
      ],
    });
    const texts = rowTexts();
    expect(texts[0]).toBe(hostile);
    expect(texts[1]).toBe("原文");
    // No markup was built: the hostile string is text, not DOM.
    expect(document.querySelector(".chat-panel img")).toBeNull();
    expect(document.querySelector(".chat-panel b")).toBeNull();
    expect(rows()[0].querySelector(".chat-panel__text")?.childElementCount).toBe(0);
  });

  it("follows the settings' live line cap and clears on a new battle", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 8,
      lines: [
        { id: 1, lang: "ja", translated: "一" },
        { id: 2, lang: "ja", translated: "二" },
        { id: 3, lang: "ja", translated: "三" },
        { id: 4, lang: "ja", translated: "四" },
      ],
    });
    expect(rows().length).toBe(4);
    emit("wowsp://chat-prefs", { maxLines: 2 });
    expect(rowTexts()).toEqual(["三", "四"]);
    // A junk cap is ignored outright; the last good value stands.
    emit("wowsp://chat-prefs", { maxLines: "many" });
    expect(rows().length).toBe(2);
    // Intake is append-only: a same-battle payload with no new lines keeps
    // the window (the buffer is the page's own state, not a snapshot).
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 8,
    });
    expect(rows().length).toBe(2);
    // A new battle with no lines clears everything — the card included (an
    // empty card would otherwise sit as a glass slab at the screen corner).
    emit("wowsp://chat-translate", {
      battle: newBattle(),
      maxLines: 8,
      lines: [],
    });
    expect(panel()).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("ignores a re-emitted line id", () => {
    const line = { id: 7, lang: "ko", translated: "중복" };
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [line, line],
    });
    expect(rowTexts()).toEqual(["중복"]);
  });
});
