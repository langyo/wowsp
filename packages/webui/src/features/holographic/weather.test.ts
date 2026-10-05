import { describe, expect, it } from "vitest";
import {
  cycloneZoneAt,
  weatherParamInfo,
  weatherParamRestrictive,
  weatherStateAt,
  weatherVisKm,
  type WeatherNotification,
  type WeatherTransition,
} from "./weather";

// Real timeline from the 2026-10-05 cyclone replay (58_RidgeNew), exactly
// as the Rust decoder emits it — including the mid-cyclone Rain→Rain
// re-assertion (542..849) that must NOT mask the still-active cyclone.
const SUNNY = 4288989104; // PCOW005_Evening
const CYCLONE = 4283746224; // PCOW010_Rain_Logic (8 km cap)

const transitions: WeatherTransition[] = [
  { time: 29.5, startTime: 0, endTime: 420, fromParam: SUNNY, toParam: SUNNY },
  { time: 450.2, startTime: 421, endTime: 541, fromParam: SUNNY, toParam: CYCLONE },
  { time: 571.5, startTime: 542, endTime: 849, fromParam: CYCLONE, toParam: CYCLONE },
  { time: 879.8, startTime: 851, endTime: 971, fromParam: CYCLONE, toParam: SUNNY },
  { time: 1000.8, startTime: 972, endTime: 6972, fromParam: SUNNY, toParam: SUNNY },
];

const notifications: WeatherNotification[] = [
  { time: 149.5, atTime: 420, param: CYCLONE },
  { time: 579.2, atTime: 849, param: SUNNY },
];

describe("weatherStateAt", () => {
  it("reports the announced weather before its window opens", () => {
    const v = weatherStateAt(transitions, notifications, 200);
    expect(v).not.toBeNull();
    expect(v!.phase).toBe("incoming");
    expect(v!.kind).toBe("cyclone");
    expect(v!.etaSeconds).toBeCloseTo(220, 5);
    expect(v!.restrictive).toBe(true);
  });

  it("stays clear while the baseline same-param window runs", () => {
    // 0..420 is Sunny→Sunny: no restriction, no pending announcement
    // before the 149.5 s notification lands.
    const before = weatherStateAt(transitions, notifications, 100);
    expect(before!.phase).toBe("incoming");
    const after = weatherStateAt(transitions, [], 400);
    expect(after).toBeNull();
  });

  it("keeps the cyclone active through its mid-state Rain→Rain re-assertion", () => {
    // 542..849 re-sends Rain→Rain while the 421..541 ramp has finished:
    // the badge must still read the fully-engaged 8 km cap, not fall back
    // to the pending "clear at 849" announcement.
    const v = weatherStateAt(transitions, notifications, 700);
    expect(v!.phase).toBe("active");
    expect(v!.kind).toBe("cyclone");
    expect(v!.visUnits).toBeCloseTo(266.6664, 3);
    expect(v!.badness).toBeCloseTo(1, 5);
  });

  it("lerps the visibility cap exactly like the server stream", () => {
    // Cross-checked against the avatar's per-second weatherParams updates:
    // t=481 is 60 s into the 120 s window → 2000 → 1133.33 units.
    const v = weatherStateAt(transitions, notifications, 481);
    expect(v!.phase).toBe("shifting");
    expect(v!.progress).toBeCloseTo(0.5, 5);
    expect(v!.visUnits).toBeCloseTo(1133.3332, 2);
    expect(v!.badness).toBeCloseTo(0.5, 5);
    expect(weatherVisKm(v)).toBeCloseTo(34.0, 1);
  });

  it("settles into the active 8 km cap after the window", () => {
    const v = weatherStateAt(transitions, notifications, 600);
    expect(v!.phase).toBe("active");
    expect(v!.visUnits).toBeCloseTo(266.6664, 3);
    expect(weatherVisKm(v)).toBeCloseTo(8.0, 3);
    expect(v!.badness).toBeCloseTo(1, 5);
  });

  it("marks the lift as clearing and returns to null once done", () => {
    const mid = weatherStateAt(transitions, notifications, 900);
    expect(mid!.phase).toBe("clearing");
    expect(mid!.kind).toBe("calm");
    expect(mid!.fromKind).toBe("cyclone");
    // 49 s into the 120 s lift (851..971): 266.67 → 974.44 units.
    expect(mid!.visUnits).toBeCloseTo(974.4443, 2);
    const done = weatherStateAt(transitions, notifications, 1200);
    expect(done).toBeNull();
  });

  it("treats unknown params as unrestricted changes", () => {
    const odd: WeatherTransition[] = [
      { time: 10, startTime: 100, endTime: 200, fromParam: SUNNY, toParam: 123456 },
    ];
    const v = weatherStateAt(odd, [], 150);
    expect(v!.kind).toBe("other");
    expect(v!.visUnits).toBeNull();
    expect(v!.restrictive).toBe(false);
  });
});

describe("weather param table", () => {
  it("knows the restrictive GlobalWeather params", () => {
    expect(weatherParamRestrictive(CYCLONE)).toBe(true);
    expect(weatherParamRestrictive(4287940528)).toBe(true); // PCOW006_Storm_Logic
    expect(weatherParamRestrictive(4284794800)).toBe(true); // PCOW009_Snowstorm_Logic
    expect(weatherParamRestrictive(SUNNY)).toBe(false);
    expect(weatherParamRestrictive(4262774704)).toBe(true); // CvC 40 km — 1333 units
  });

  it("maps ids to kinds", () => {
    expect(weatherParamInfo(CYCLONE).kind).toBe("cyclone");
    expect(weatherParamInfo(4284794800).kind).toBe("snowstorm");
    expect(weatherParamInfo(4269066160).kind).toBe("storm");
    expect(weatherParamInfo(SUNNY).kind).toBe("calm");
  });
});

describe("cycloneZoneAt", () => {
  it("keeps the core inside the map and deterministic in t", () => {
    const a = cycloneZoneAt(-700, 700, -700, 700, 1, 600, 421);
    const b = cycloneZoneAt(-700, 700, -700, 700, 1, 600, 421);
    expect(a).toEqual(b);
    expect(a.radius).toBeGreaterThan(0.6 * 1400 * 0.9);
    // Deterministic in the seed: another match drifts another way.
    const c = cycloneZoneAt(-700, 700, -700, 700, 1, 600, 300);
    expect(Math.hypot(c.cx - a.cx, c.cz - a.cz)).toBeGreaterThan(1);
  });

  it("shrinks the core as badness fades", () => {
    const heavy = cycloneZoneAt(-700, 700, -700, 700, 1, 500, 421);
    const light = cycloneZoneAt(-700, 700, -700, 700, 0.3, 500, 421);
    expect(light.radius).toBeLessThan(heavy.radius);
  });
});
