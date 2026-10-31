import { describe, expect, it } from "vitest";

import type { CloudBanMatch } from "@/api";

import { cloudMatchHint } from "./cloudBan";

const LABELS = {
  title: "通过云端名单匹配：疑似封禁历史，仅供参考",
  banTime: "封禁日期",
  banName: "官方封禁名",
  userName: "历史用户名",
  namesake: "相似用户数",
};

function match(records: CloudBanMatch["records"]): CloudBanMatch {
  return {
    accountId: 1,
    nickname: "Hacker",
    matched: true,
    dismissed: false,
    records,
    fetchedAt: 0,
  };
}

describe("cloudMatchHint", () => {
  it("composes the title with the first record's details", () => {
    const hint = cloudMatchHint(
      match([
        {
          banName: "BannedName",
          userName: "PastName",
          banTime: "2023-05-01",
          recordTime: null,
          namesake: 1,
        },
      ]),
      LABELS,
    );
    expect(hint).toBe(
      "通过云端名单匹配：疑似封禁历史，仅供参考" +
        ": 封禁日期 2023-05-01, 官方封禁名 BannedName, 历史用户名 PastName, 相似用户数 1",
    );
  });

  it("counts extra records with a (+n) suffix", () => {
    const hint = cloudMatchHint(
      match([
        { banName: "A", banTime: "2023-01-01", namesake: 1 },
        { banName: "B", namesake: 2 },
        { banName: "C", namesake: 3 },
      ]),
      LABELS,
    );
    expect(hint).toContain("(+2)");
    expect(hint).not.toContain("B");
  });

  it("skips absent fields instead of leaving blanks", () => {
    const hint = cloudMatchHint(match([{ namesake: 1 }]), LABELS);
    expect(hint).toBe("通过云端名单匹配：疑似封禁历史，仅供参考: 相似用户数 1");
  });

  it("degrades to the bare title when the answer carried no records", () => {
    expect(cloudMatchHint(match([]), LABELS)).toBe(LABELS.title);
  });
});
