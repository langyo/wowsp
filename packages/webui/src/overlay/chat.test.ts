/**
 * Page-level regression for the battle-chat translation card, driven the way
 * production drives it: the real chat.ts bootstrap against a mocked
 * `window.__TAURI__`, then the bridge's two events.
 *
 * Pins the upgraded line face (chat.ts):
 *   - TWO rows per line — the original row (channel marker + sender + self
 *     tag + muted original + language badge) above the translated body;
 *   - no translated row at all when the translation is empty;
 *   - the team/division channel markers (battle_team muted blue tag,
 *     battle_prebattle gold diamond, every other channel unmarked);
 *   - the local player's own line highlighted with the localized "me" tag;
 *   - the buffer contract (newest `maxLines` only, chat order kept by id, a
 *     different battle id clears everything, re-emitted ids merge in place
 *     so a late translation fills its row, an empty buffer renders NO nodes
 *     at all);
 *   - `textContent` rendering only — arbitrary chat input stays literal.
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
/** Each row's ORIGINAL text cell (the muted top line). */
const originals = (): string[] =>
  rows().map((r) => r.querySelector(".chat-panel__text")?.textContent ?? "");
/** Each row's translated cell, or null when the row has no translation. */
const translations = (): Array<string | null> =>
  rows().map((r) => {
    const body = r.querySelector<HTMLElement>(".chat-panel__translated");
    return body ? body.textContent : null;
  });
const fromOf = (row: HTMLElement): string | undefined =>
  row.querySelector<HTMLElement>(".chat-panel__from")?.textContent ?? undefined;

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

  it("renders a two-row line: muted original above, translation below", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 2,
      lines: [
        { id: 1, from: "Foe", lang: "ja", text: "原文一", translated: "译文一" },
        { id: 2, from: "Mate", lang: "ko", text: "원문", translated: "번역" },
        { id: 3, from: "Third", lang: "zh-TW", text: "三", translated: "三譯" },
      ],
    });
    // The cap keeps the newest two lines only.
    expect(rows().length).toBe(2);
    expect(originals()).toEqual(["원문", "三"]);
    expect(translations()).toEqual(["번역", "三譯"]);
    // The original and the translation are SEPARATE rows of one line: the
    // translated cell is not inside the original row.
    const first = rows()[0];
    expect(first.querySelector(".chat-panel__orig")?.contains(
      first.querySelector(".chat-panel__translated"),
    )).toBe(false);
    // Sender + language badge ride the original row.
    expect(fromOf(first)).toBe("Mate");
    expect(first.querySelector(".chat-panel__lang")?.textContent).toBe("ko");
    // A line's row carries its source language for glyph selection.
    expect(first.getAttribute("lang")).toBe("ko");
    expect(panel()?.getAttribute("role")).toBe("log");
    expect(panel()?.getAttribute("aria-label")).toBe("Chat translation");
  });

  it("renders only the original row when the translation is empty", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [
        { id: 1, from: "one", lang: "en", text: "gg", translated: "" },
        { id: 2, from: "two", lang: "ja", text: "了解" },
        { id: 3, from: "three", lang: "ko", text: "확인", translated: "   " },
      ],
    });
    expect(originals()).toEqual(["gg", "了解", "확인"]);
    // No translated node exists on any of them — the line stays single-row.
    expect(translations()).toEqual([null, null, null]);
    for (const row of rows()) {
      expect(row.querySelector(".chat-panel__translated")).toBeNull();
    }
  });

  it("marks team and division channels with their own colored markers", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [
        { id: 1, ns: "battle_team", from: "A", text: "team", translated: "t" },
        { id: 2, ns: "battle_prebattle", from: "B", text: "div", translated: "d" },
        { id: 3, ns: "battle_common", from: "C", text: "all", translated: "a" },
      ],
    });
    const [team, division, common] = rows();
    const teamMarker = team.querySelector<HTMLElement>(".chat-panel__ns");
    expect(teamMarker?.classList.contains("chat-panel__ns--team")).toBe(true);
    // The localized team tag names the channel.
    expect(teamMarker?.textContent).toBe("[Team]");
    const divisionMarker = division.querySelector<HTMLElement>(".chat-panel__ns");
    expect(divisionMarker?.classList.contains("chat-panel__ns--prebattle")).toBe(true);
    // Division chat is a language-neutral gold diamond (the team tag would
    // name the wrong channel).
    expect(divisionMarker?.textContent).toBe("◆");
    // battle_common carries no marker at all.
    expect(common.querySelector(".chat-panel__ns")).toBeNull();
  });

  it("highlights the local player's own line with the localized self tag", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [
        { id: 1, from: "me", selfLine: true, lang: "zh-CN", text: "我发的", translated: "my line" },
        { id: 2, from: "other", selfLine: false, lang: "zh-CN", text: "别人", translated: "theirs" },
      ],
    });
    const [mine, theirs] = rows();
    expect(mine.classList.contains("chat-panel__line--self")).toBe(true);
    expect(mine.querySelector(".chat-panel__self")?.textContent).toBe("me");
    expect(theirs.classList.contains("chat-panel__line--self")).toBe(false);
    expect(theirs.querySelector(".chat-panel__self")).toBeNull();
  });

  it("names each line for assistive tech from its original sender", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [
        { id: 1, from: "[TAG]Friend", text: "hi" },
        // Unknown sender: nothing to name the group after.
        { id: 2, text: "system?" },
      ],
    });
    const [named, anonymous] = rows();
    expect(named.getAttribute("role")).toBe("group");
    expect(named.getAttribute("aria-label")).toBe("Original message from [TAG]Friend");
    expect(anonymous.getAttribute("aria-label")).toBeNull();
  });

  it("draws chat input literally and falls back to nothing but the original", () => {
    const hostile = '<img src=x onerror="alert(1)"><b>bold</b>';
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [{ id: 1, from: "evil", lang: "en", text: hostile, translated: hostile }],
    });
    expect(originals()[0]).toBe(hostile);
    expect(translations()[0]).toBe(hostile);
    // No markup was built: the hostile string is text, not DOM.
    expect(document.querySelector(".chat-panel img")).toBeNull();
    expect(document.querySelector(".chat-panel b")).toBeNull();
    expect(rows()[0].querySelector(".chat-panel__translated")?.childElementCount).toBe(0);
  });

  it("follows the settings' live line cap and clears on a new battle", () => {
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 8,
      lines: [
        { id: 1, lang: "ja", text: "一", translated: "one" },
        { id: 2, lang: "ja", text: "二", translated: "two" },
        { id: 3, lang: "ja", text: "三", translated: "three" },
        { id: 4, lang: "ja", text: "四", translated: "four" },
      ],
    });
    expect(rows().length).toBe(4);
    emit("wowsp://chat-prefs", { maxLines: 2 });
    expect(originals()).toEqual(["三", "四"]);
    // A junk cap is ignored outright; the last good value stands.
    emit("wowsp://chat-prefs", { maxLines: "many" });
    expect(rows().length).toBe(2);
    // A same-battle payload with no new lines keeps the window (the buffer
    // is the page's own state; the event is just a snapshot to merge).
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

  it("merges a re-emitted snapshot line in place (translation lands late)", () => {
    // The snapshot first carries the line while its translation is pending...
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [{ id: 7, from: "mate", lang: "ja", text: "原文", translated: "" }],
    });
    expect(rows().length).toBe(1);
    expect(translations()).toEqual([null]);
    // ...and a later snapshot re-sends the SAME id with the translation: the
    // row is updated, never duplicated.
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [{ id: 7, from: "mate", lang: "ja", text: "原文", translated: "译文" }],
    });
    expect(rows().length).toBe(1);
    expect(originals()).toEqual(["原文"]);
    expect(translations()).toEqual(["译文"]);
    // A duplicated id inside ONE payload collapses to a single row.
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      lines: [
        { id: 8, lang: "ko", text: "중복", translated: "dup" },
        { id: 8, lang: "ko", text: "중복", translated: "dup" },
      ],
    });
    expect(rows().length).toBe(2);
  });

  it("keeps chat order when a grown snapshot back-fills older lines", () => {
    // A 2-line cap trims the buffer to the newest lines...
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 2,
      lines: [
        { id: 1, text: "一", translated: "one" },
        { id: 2, text: "二", translated: "two" },
        { id: 3, text: "三", translated: "three" },
      ],
    });
    expect(originals()).toEqual(["二", "三"]);
    // ...then the cap grows and the snapshot back-fills the older ids: they
    // must land BACK in chat order (sorted by id), not after the newer ones.
    emit("wowsp://chat-translate", {
      battle: currentBattle,
      maxLines: 8,
      lines: [
        { id: 1, text: "一", translated: "one" },
        { id: 2, text: "二", translated: "two" },
        { id: 3, text: "三", translated: "three" },
      ],
    });
    expect(originals()).toEqual(["一", "二", "三"]);
    expect(translations()).toEqual(["one", "two", "three"]);
  });
});
