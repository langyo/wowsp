/**
 * Tests for the onboarding player-candidate grouping: realm grouping in
 * the shared server order, the "one per server" default selection (each
 * realm's most-evidence row), and the checkbox key's collision safety.
 */
import { describe, expect, it } from "vitest";

import type { ReplayPlayerCandidate } from "@/api";

import {
  candidateKey,
  defaultSelection,
  groupCandidatesByRealm,
} from "./replayPlayerCandidates";

/** Answer order fixture — the backend sends battles desc / newest desc /
 *  nickname asc, and the grouping preserves that order inside a realm. */
const ROWS: ReplayPlayerCandidate[] = [
  { realm: "asia", nickname: "langyo", battles: 40, lastDateTime: "20261020_210000" },
  { realm: "ru", nickname: "langyo", battles: 12, lastDateTime: "20261018_190000" },
  { realm: "asia", nickname: "SharedMachine", battles: 3, lastDateTime: "20261001_090000" },
  { realm: "cn", nickname: "\u67d0\u67da", battles: 1, lastDateTime: "20260930_120000" },
];

describe("groupCandidatesByRealm", () => {
  it("groups rows per realm in the shared known-realm order", () => {
    const groups = groupCandidatesByRealm(ROWS, ["ru", "eu", "na", "asia", "cn"]);
    expect(groups.map((g) => g.realm)).toEqual(["ru", "asia", "cn"]);
    // Answer order survives inside a group (most evidence first).
    expect(groups[1].rows.map((r) => r.nickname)).toEqual(["langyo", "SharedMachine"]);
  });

  it("keeps unknown realm codes after the known ones, alphabetical", () => {
    const rows: ReplayPlayerCandidate[] = [
      { realm: "zz", nickname: "A", battles: 1, lastDateTime: null },
      { realm: "aa", nickname: "B", battles: 1, lastDateTime: null },
      { realm: "eu", nickname: "C", battles: 1, lastDateTime: null },
    ];
    expect(groupCandidatesByRealm(rows, ["ru", "eu"]).map((g) => g.realm)).toEqual([
      "eu",
      "aa",
      "zz",
    ]);
  });

  it("answers an empty group list for an empty answer", () => {
    expect(groupCandidatesByRealm([], ["ru", "eu", "na", "asia", "cn"])).toEqual([]);
  });
});

describe("defaultSelection", () => {
  it("preselects exactly one row per realm — the most-evidence head", () => {
    const groups = groupCandidatesByRealm(ROWS, ["ru", "eu", "na", "asia", "cn"]);
    const selected = defaultSelection(groups);
    expect([...selected]).toEqual([
      candidateKey({ realm: "ru", nickname: "langyo" }),
      candidateKey({ realm: "asia", nickname: "langyo" }),
      candidateKey({ realm: "cn", nickname: "\u67d0\u67da" }),
    ]);
    // The shared machine's second ASIA row stays UNchecked until the user
    // opts in — "only my own players are included".
    expect(selected.has(candidateKey({ realm: "asia", nickname: "SharedMachine" }))).toBe(false);
  });
});

describe("candidateKey", () => {
  it("separates realm from nickname — same nickname on two servers stays two rows", () => {
    expect(candidateKey({ realm: "asia", nickname: "langyo" })).not.toBe(
      candidateKey({ realm: "ru", nickname: "langyo" }),
    );
  });
});
