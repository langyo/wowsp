/** Tests for the Tab row-order comparator's two client permutations: the
 *  decompiled nation-rank concatenation (WG clients, byte-compatible with
 *  gameTabRowKey) and the ship-name order (localized name collated by
 *  pinyin — the permutation the CN 360 client renders and the Lesta
 *  client shares, which plain code-unit comparison gets backwards for
 *  hanzi). */
import { describe, expect, it } from "vitest";

import { gameTabRowCompare, gameTabRowKey } from "./shipClass";

// Real offline-DB ship ids — the T2 cruiser group of the observed CN
// co-op battle (2026-10-07) plus its tier-III cruiser, and the Lesta
// co-op capture (2026-10-09, realm ru).
const SHIPS = {
  gelderland: 4187928336, // Cruiser T2 netherlands 海尔德兰
  portJackson: 4282299760, // Cruiser T2 commonwealth 杰克逊港
  chester: 4292786160, // Cruiser T2 usa 切斯特
  weymouth: 4187928528, // Cruiser T2 united_kingdom 韦茅斯
  tenryu: 4279154384, // Cruiser T3 japan 豺 (Tenryū)
  nassau: 4186912560, // Battleship T3 germany 拿骚
  bogatyr: 4186879440, // Cruiser T3 russia 博加特里
  stLouis: 4290689008, // Cruiser T3 usa 圣路易斯
  v25: 4187895600, // Destroyer T2 germany V-25
};

const opts = (shipNameOrder: boolean) => ({ locale: "zh-CN", shipNameOrder });

describe("gameTabRowCompare", () => {
  it("orders the observed CN cruiser group by pinyin ship name", () => {
    // 海(hǎi) < 杰(jié) < 切(qiè) < 韦(wéi) — the client's rendered order.
    // Plain UTF-16 comparison would give 切(0x5207) < 杰(0x6770) < 海(0x6D77)
    // < 韦(0x97E6) — the exact misorder this comparator exists to avoid.
    const group = [
      { name: ":Tributs:", shipId: SHIPS.weymouth },
      { name: ":Apostolis:", shipId: SHIPS.gelderland },
      { name: "神楽坂柚咲", shipId: SHIPS.chester },
      { name: ":Millo:", shipId: SHIPS.portJackson },
    ];
    const sorted = [...group].sort((a, b) => gameTabRowCompare(a, b, opts(true)));
    expect(sorted.map((v) => v.name)).toEqual([
      ":Apostolis:",
      ":Millo:",
      "神楽坂柚咲",
      ":Tributs:",
    ]);
  });

  it("orders the observed Lesta roster by ship name, not nation", () => {
    // 2026-10-09 Lesta co-op Tab capture (realm ru) — the game rendered
    // Sturdee → BILTEMA8 → Fisher → langyo → Navy_804 → Hollmann. Under
    // the decompiled nation rank (usa < russia) both 圣路易斯(USA) rows
    // jump ahead of 博加特里(RUS) — the shipped misorder the live panel
    // showed (the Bogatyr row landing after both St. Louis rows); the
    // ship-name order is the fix.
    const roster = [
      { name: "langyo", shipId: SHIPS.stLouis },
      { name: ":Sturdee:", shipId: SHIPS.nassau },
      { name: "Navy_804", shipId: SHIPS.weymouth },
      { name: "BILTEMA8", shipId: SHIPS.bogatyr },
      { name: ":Hollmann:", shipId: SHIPS.v25 },
      { name: ":Fisher:", shipId: SHIPS.stLouis },
    ];
    const wg = [...roster].sort((a, b) => gameTabRowCompare(a, b, opts(false)));
    expect(wg.map((v) => v.name)).toEqual([
      ":Sturdee:",
      ":Fisher:",
      "langyo",
      "BILTEMA8",
      "Navy_804",
      ":Hollmann:",
    ]);
    const lesta = [...roster].sort((a, b) =>
      gameTabRowCompare(a, b, {
        ...opts(true),
        clanTagOf: (v) => (v.name === "BILTEMA8" ? "PLC" : null),
      }),
    );
    // 博加特里(bó) leads the 圣路易斯(shèng) pair; the tier-III BB opens
    // and the tier-II cruiser/destroyer close — the client's exact order.
    expect(lesta.map((v) => v.name)).toEqual([
      ":Sturdee:",
      "BILTEMA8",
      ":Fisher:",
      "langyo",
      "Navy_804",
      ":Hollmann:",
    ]);
  });

  it("keeps tier above the name segment on the CN order", () => {
    // 豺(chái) sorts before 海(hǎi) pinyin-wise too, but the tier III cruiser
    // leads the tier II group regardless of the name segment.
    const group = [
      { name: ":Apostolis:", shipId: SHIPS.gelderland },
      { name: "用户_78851053968", shipId: SHIPS.tenryu },
    ];
    const sorted = [...group].sort((a, b) => gameTabRowCompare(a, b, opts(true)));
    expect(sorted.map((v) => v.name)).toEqual([
      "用户_78851053968",
      ":Apostolis:",
    ]);
  });

  it("matches the concatenated nation key byte for byte on WG clients", () => {
    // Default options compare exactly the legacy key strings.
    const group = [
      { name: "zed", shipId: SHIPS.weymouth },
      { name: "bob", shipId: SHIPS.chester },
      { name: "Alice", shipId: SHIPS.gelderland },
      { name: "dave", shipId: SHIPS.portJackson },
    ];
    const viaCompare = [...group].sort((a, b) => gameTabRowCompare(a, b, opts(false)));
    const viaKey = [...group].sort((a, b) => {
      const ka = gameTabRowKey(a, true, "zh-CN");
      const kb = gameTabRowKey(b, true, "zh-CN");
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    expect(viaCompare.map((v) => v.name)).toEqual(viaKey.map((v) => v.name));
  });

  it("uses the clan tag as the CN order's final tiebreak", () => {
    // Two same-ship entries: the collated names tie, the display names
    // decide, and '[CLAN]zed' jumps ahead of lowercase 'bob' exactly like
    // the client's own compare.
    const group = [
      { name: "zed", shipId: SHIPS.weymouth },
      { name: "bob", shipId: SHIPS.weymouth },
    ];
    const tagged = [...group].sort((a, b) =>
      gameTabRowCompare(a, b, { ...opts(true), clanTagOf: (v) => (v.name === "zed" ? "CLAN" : null) }),
    );
    expect(tagged.map((v) => v.name)).toEqual(["zed", "bob"]);
  });

  it("keeps the class block ahead of the unknown-DB sentinel", () => {
    // An unknown ship reports classRank 5 (everything else) — it must sort
    // after a KNOWN cruiser (class 2); the sentinel lives INSIDE the class
    // group, mirroring the legacy key's segment order (class, then '~'
    // tier/nation).
    const group = [
      { name: "mystery", shipId: 1234567890 }, // not in the offline DB
      { name: "knownCA", shipId: SHIPS.tenryu }, // Cruiser T3 japan
    ];
    const sorted = [...group].sort((a, b) => gameTabRowCompare(a, b, opts(true)));
    expect(sorted.map((v) => v.name)).toEqual(["knownCA", "mystery"]);
  });

  it("collates the display-name tiebreak too under the CN order", () => {
    // Same ship (the classic division twins): the collated ship names tie,
    // so the '[TAG]nickname' segment decides — and the client's whole-key
    // comparison collates it, so hanzi nicknames order by pinyin
    // (shén < yòng: 神楽坂柚咲 before 用户_78851053968). Code-unit comparison
    // would put 用户_… first (U+7528 < U+795E) — the divergence this arm
    // exists to avoid. The WG path keeps code unit order (byte-compat with
    // the legacy key), where 用户_… does sort first.
    const twins = [
      { name: "用户_78851053968", shipId: SHIPS.tenryu },
      { name: "神楽坂柚咲", shipId: SHIPS.tenryu },
    ];
    const cn = [...twins].sort((a, b) => gameTabRowCompare(a, b, opts(true)));
    expect(cn.map((v) => v.name)).toEqual(["神楽坂柚咲", "用户_78851053968"]);
    const wg = [...twins].sort((a, b) => gameTabRowCompare(a, b, opts(false)));
    expect(wg.map((v) => v.name)).toEqual(["用户_78851053968", "神楽坂柚咲"]);
  });
});
