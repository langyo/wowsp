/** Unit tests for the replay camera-mode (0x27) semantics + aircraft windows. */
import { describe, expect, it } from "vitest";
import {
  cameraModeAt,
  cameraModeIdAt,
  isPlaneCameraMode,
  nearestPlaneCameraWindow,
  planeCameraJumpTarget,
  planeCameraWindows,
  recordedCameraMode,
  type RecordedCameraMode,
} from "./cameraModes";

/** Minimal 0x27 sample: raw mode id at a match time. */
const s = (time: number, value: number) => ({ time, value });

describe("recordedCameraMode", () => {
  it("maps every entry of the default CAMERA_MODES id table", () => {
    const table: [number, RecordedCameraMode][] = [
      [1, "airplanes"],
      [2, "dock"],
      [3, "overheadMap"],
      [4, "devFree"],
      [5, "followingShells"],
      [6, "followingPlanes"],
      [7, "dockModule"],
      [8, "followingShip"],
      [9, "freeFlying"],
      [10, "replayFpc"],
      [11, "followingSubmarine"],
      [12, "tacticalConsumables"],
      [13, "respawnMap"],
      [19, "dockFlags"],
      [20, "dockEnsign"],
      [21, "dockLootbox"],
      [22, "dockNavalFlag"],
      [23, "idleGame"],
    ];
    for (const [id, mode] of table) expect(recordedCameraMode(id)).toBe(mode);
  });

  it("answers null for unknown / missing / non-integer ids", () => {
    expect(recordedCameraMode(0)).toBeNull();
    expect(recordedCameraMode(14)).toBeNull();
    expect(recordedCameraMode(18)).toBeNull();
    expect(recordedCameraMode(24)).toBeNull();
    expect(recordedCameraMode(999)).toBeNull();
    expect(recordedCameraMode(6.5)).toBeNull();
    expect(recordedCameraMode(null)).toBeNull();
    expect(recordedCameraMode(undefined)).toBeNull();
  });
});

describe("isPlaneCameraMode", () => {
  it("accepts the two aircraft camera modes", () => {
    expect(isPlaneCameraMode("airplanes")).toBe(true);
    expect(isPlaneCameraMode("followingPlanes")).toBe(true);
  });

  it("rejects every other mode and null", () => {
    const others: RecordedCameraMode[] = [
      "dock",
      "overheadMap",
      "devFree",
      "followingShells",
      "dockModule",
      "followingShip",
      "freeFlying",
      "replayFpc",
      "followingSubmarine",
      "tacticalConsumables",
      "respawnMap",
      "dockFlags",
      "dockEnsign",
      "dockLootbox",
      "dockNavalFlag",
      "idleGame",
    ];
    for (const mode of others) expect(isPlaneCameraMode(mode)).toBe(false);
    expect(isPlaneCameraMode(null)).toBe(false);
    expect(isPlaneCameraMode(undefined)).toBe(false);
  });
});

describe("cameraModeIdAt", () => {
  const stream = [s(5, 8), s(10, 6), s(20, 1), s(30, 8)];

  it("returns null for an empty stream or a playhead before it starts", () => {
    expect(cameraModeIdAt(undefined, 0)).toBeNull();
    expect(cameraModeIdAt([], 0)).toBeNull();
    expect(cameraModeIdAt(stream, 4.9)).toBeNull();
  });

  it("holds the last mode at or before t (step semantics)", () => {
    expect(cameraModeIdAt(stream, 5)).toBe(8);
    expect(cameraModeIdAt(stream, 9.9)).toBe(8);
    expect(cameraModeIdAt(stream, 10)).toBe(6);
    expect(cameraModeIdAt(stream, 25)).toBe(1);
    expect(cameraModeIdAt(stream, 99)).toBe(8);
  });
});

describe("cameraModeAt", () => {
  const stream = [s(5, 8), s(10, 6), s(20, 1), s(30, 8)];

  it("names the recorded mode at the playhead", () => {
    expect(cameraModeAt(stream, 4.9)).toBeNull();
    expect(cameraModeAt(stream, 10)).toBe("followingPlanes");
    expect(cameraModeAt(stream, 19)).toBe("followingPlanes");
    expect(cameraModeAt(stream, 20)).toBe("airplanes");
    expect(cameraModeAt(stream, 40)).toBe("followingShip");
  });

  it("answers null for an unknown raw id instead of guessing", () => {
    expect(cameraModeAt([s(1, 999)], 2)).toBeNull();
    expect(cameraModeAt(undefined, 2)).toBeNull();
  });
});

describe("planeCameraJumpTarget", () => {
  it("answers null when the replay never recorded an aircraft camera", () => {
    expect(planeCameraJumpTarget(undefined, 100, 10)).toBeNull();
    expect(planeCameraJumpTarget([s(10, 8)], 100, 10)).toBeNull();
  });

  it("only switches the view while the recorded mode is already an aircraft camera", () => {
    const stream = [s(10, 6), s(30, 8)];
    expect(planeCameraJumpTarget(stream, 100, 15)).toEqual({ seekTo: null });
    // The synthesized last-window end equals the replay duration while the
    // recorded mode can still read followingPlanes → no rewind there.
    expect(planeCameraJumpTarget([s(10, 6)], 42, 42)).toEqual({ seekTo: null });
  });

  it("seeks to the nearest segment start outside the recorded aircraft camera", () => {
    // At the exclusive end the closing 0x27 sample already left the aircraft
    // camera, so the press seeks back to that segment's start.
    expect(planeCameraJumpTarget([s(10, 6), s(30, 8)], 100, 30)).toEqual({
      seekTo: 10,
    });
    expect(planeCameraJumpTarget([s(10, 6), s(30, 8)], 100, 5)).toEqual({
      seekTo: 10,
    });
  });
});

describe("planeCameraWindows", () => {
  it("returns no windows for an empty stream", () => {
    expect(planeCameraWindows(undefined, 100)).toEqual([]);
    expect(planeCameraWindows([], 100)).toEqual([]);
  });

  it("closes an open window at the replay duration", () => {
    expect(planeCameraWindows([s(10, 6)], 42)).toEqual([
      { start: 10, end: 42, id: 6 },
    ]);
    // The synthesized end still reads followingPlanes at cameraModeAt: the
    // jump path keys off the recorded mode, not the window boundary, so a
    // playhead at the replay end is not rewound.
    expect(cameraModeAt([s(10, 6)], 42)).toBe("followingPlanes");
  });

  it("clips a window whose closing sample lands past the replay duration", () => {
    // The 0x27 stream can run past the decoded trajectory horizon: the
    // window must end at the playable clock, never outside it.
    expect(planeCameraWindows([s(10, 6), s(60, 8)], 50)).toEqual([
      { start: 10, end: 50, id: 6 },
    ]);
    // A window that opens past the horizon collapses entirely.
    expect(planeCameraWindows([s(50, 6), s(60, 8)], 40)).toEqual([]);
    expect(planeCameraWindows([s(50, 6)], 40)).toEqual([]);
  });

  it("keeps an airplanes↔followingPlanes crossing in ONE window", () => {
    expect(planeCameraWindows([s(10, 1), s(20, 6), s(30, 8)], 100)).toEqual([
      { start: 10, end: 30, id: 1 },
    ]);
  });

  it("splits windows on any non-plane mode change", () => {
    expect(
      planeCameraWindows([s(10, 6), s(20, 8), s(30, 1)], 100),
    ).toEqual([
      { start: 10, end: 20, id: 6 },
      { start: 30, end: 100, id: 1 },
    ]);
  });

  it("ignores leading non-plane samples and unknown ids", () => {
    expect(planeCameraWindows([s(0, 8), s(5, 999), s(10, 6)], 20)).toEqual([
      { start: 10, end: 20, id: 6 },
    ]);
  });

  it("drops zero-length windows (same-timestamp flip, start past duration)", () => {
    expect(planeCameraWindows([s(10, 6), s(10, 8)], 100)).toEqual([]);
    expect(planeCameraWindows([s(50, 6)], 40)).toEqual([]);
    expect(planeCameraWindows([s(50, 6)], 50)).toEqual([]);
  });

  it("treats a negative duration as zero", () => {
    expect(planeCameraWindows([s(0, 6)], -5)).toEqual([]);
  });
});

describe("nearestPlaneCameraWindow", () => {
  it("returns null when the replay has no aircraft-camera segment", () => {
    expect(nearestPlaneCameraWindow([], 100, 5)).toBeNull();
    expect(nearestPlaneCameraWindow([s(0, 8), s(10, 6)], 20, 5)).toEqual({
      start: 10,
      end: 20,
      id: 6,
    });
    expect(nearestPlaneCameraWindow(undefined, 100, 0)).toBeNull();
  });

  // Windows: [10, 20] and [30, 40], duration 50.
  const stream = [s(10, 6), s(20, 8), s(30, 1), s(40, 9)];

  it("picks the containing window for a playhead inside it", () => {
    expect(nearestPlaneCameraWindow(stream, 50, 10)).toEqual({
      start: 10,
      end: 20,
      id: 6,
    });
    expect(nearestPlaneCameraWindow(stream, 50, 19.5)).toEqual({
      start: 10,
      end: 20,
      id: 6,
    });
    expect(nearestPlaneCameraWindow(stream, 50, 35)).toEqual({
      start: 30,
      end: 40,
      id: 1,
    });
  });

  it("picks the closest window outside the segments", () => {
    expect(nearestPlaneCameraWindow(stream, 50, 0)).toEqual({
      start: 10,
      end: 20,
      id: 6,
    });
    expect(nearestPlaneCameraWindow(stream, 50, 27)).toEqual({
      start: 30,
      end: 40,
      id: 1,
    });
    expect(nearestPlaneCameraWindow(stream, 50, 49)).toEqual({
      start: 30,
      end: 40,
      id: 1,
    });
  });

  it("resolves an equidistant tie to the earlier window", () => {
    // t=25 sits halfway between the end of [10,20] and the start of [30,40].
    expect(nearestPlaneCameraWindow(stream, 50, 25)).toEqual({
      start: 10,
      end: 20,
      id: 6,
    });
  });
});
