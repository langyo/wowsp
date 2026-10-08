/**
 * LIVE CALIBRATION test — pins buildSelfStats against a REAL Lesta battle.
 *
 * The fixture (lesta_live_stream.json) is the actual LiveSelfStream decoded
 * from the 2026-10-08 17:33 co-op battle (St. Louis, 16_OC_bees_to_honey)
 * whose results screen supplies the ground truth:
 *
 *   damage 26,722   hits 73   kills 3   damage taken 3,302
 *
 * It is NOT committed (the raw stream is ~2 MB of position samples): the
 * ignored Rust test regenerate_live_calibration_fixture rebuilds it from a
 * local replay —
 *
 *   WOWSP_TEST_REPLAY=<replay file> \
 *   WOWSP_CALIB_FIXTURE=<webui>/src/features/replay/__fixtures__/lesta_live_stream.json \
 *     cargo test -p wowsp_tauri regenerate_live_calibration_fixture -- --ignored
 *
 * The test skips when the fixture is absent (fresh clones, CI), mirroring
 * the ignored real-replay tests on the Rust side.
 */
import { describe, expect, it } from "vitest";

import type { LiveSelfStream, VehicleEntry } from "@/api";
import { buildSelfStats } from "./liveSelfStats";

// The fixture loads through vite's lazy glob (typed by vite/client — the
// webui tsconfig carries no node types): present locally → the loader
// resolves; absent (fresh clones, CI) → the map is empty and the test
// skips. No node imports, no dependency changes.
const fixtures = import.meta.glob("./__fixtures__/*.json");

describe("live calibration vs a real Lesta battle", () => {
  it("matches the results screen within the estimate tolerances", async () => {
    const loader = fixtures["./__fixtures__/lesta_live_stream.json"];
    if (loader == null) {
      console.warn("calibration fixture absent — regenerate from the local replay");
      return;
    }
    const mod = (await loader()) as { default: unknown };
    const stream = JSON.parse(JSON.stringify(mod.default)) as LiveSelfStream;
    const rosterName = "langyo";
    const m = buildSelfStats({
      stream,
      roster: (stream.arenaPlayers ?? []).map(
        (p): VehicleEntry => ({
          id: p.playerId ?? 0,
          name: p.name ?? "",
          relation: p.isSelf ? 0 : p.teamId === 0 ? 1 : 2,
          shipId: p.shipParamsId ?? 0,
        }),
      ),
      dataLang: "zh-CN",
    });

    expect(m).not.toBeNull();
    // Self identity: the recorder's ship survived (damage taken 3,302 of
    // ~27k cannot sink), name from the roster join.
    expect(m!.selfName).toBe(rosterName);
    expect(m!.selfEntityId).not.toBeNull();
    expect(m!.sunk).toBe(false);

    // Server damage stream: 26,723.5 folded vs the screen's 26,722 — the
    // float32 server totals vs the results accounting; within 0.01%.
    expect(m!.damageSource).toBe("server");
    expect(Math.abs(m!.damage - 26722)).toBeLessThanOrEqual(10);

    // Impact-stream hits: within a handful of the game's 73 direct-hit
    // ribbons (splash volleys on already-sunk ships differ).
    expect(Math.abs(m!.hits - 73)).toBeLessThanOrEqual(5);

    // Kill attribution envelope: Lesta replays carry NO BattleResults
    // payload (0x22 empty in both the live and the settled container —
    // verified on this very replay), so killer attribution does not exist
    // in the data source at all and the death-proximity estimate is the
    // best available: direct-window kills land reliably, DoT kills
    // (fire/flood-out seconds after my last shell) ride the engagement
    // fallback. The screen said 3; the estimate envelope is [2, 4].
    expect(m!.frags).toBeGreaterThanOrEqual(2);
    expect(m!.frags).toBeLessThanOrEqual(4);

    // The per-target ledgers must be POPULATED (the pre-fix failure mode:
    // totals without any rows, both lists stuck on 暂无记录).
    expect(m!.dealt.length).toBeGreaterThan(0);
    const topDealt = m!.dealt[0]!;
    expect(topDealt.damage).toBeGreaterThan(0);

    // Hull: ~3.3k taken of ~27k.
    expect(m!.taken).toBeGreaterThan(0);
    expect(m!.hpRatio).toBeGreaterThan(50);
  });
});
