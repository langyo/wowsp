/** Unit tests for the holographic map's follow-mode chase pose solver. */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  AI_FOCUS_PLANE_DIST,
  AI_FOCUS_SHIP_DIST,
  applyFollowPose,
  CHASE_RISE,
  CHASE_RUN,
  clampFollowDist,
  FOLLOW_DIST_DEFAULT,
  FOLLOW_DIST_MAX,
  FOLLOW_DIST_MIN,
  followFramingCleared,
  followFramingFor,
  followFramingZoomed,
  initialFollowFraming,
  PLANE_FOLLOW_DIST_DEFAULT,
  stockFollowDist,
} from "./followCamera";

describe("clampFollowDist", () => {
  it("keeps in-range distances untouched", () => {
    expect(clampFollowDist(FOLLOW_DIST_DEFAULT)).toBe(FOLLOW_DIST_DEFAULT);
    expect(clampFollowDist(300)).toBe(300);
  });

  it("clamps to the chase zoom range", () => {
    expect(clampFollowDist(1)).toBe(FOLLOW_DIST_MIN);
    expect(clampFollowDist(99999)).toBe(FOLLOW_DIST_MAX);
  });

  it("passes the aircraft-follow and AI-focus presets through unclamped", () => {
    expect(clampFollowDist(PLANE_FOLLOW_DIST_DEFAULT)).toBe(
      PLANE_FOLLOW_DIST_DEFAULT,
    );
    expect(clampFollowDist(AI_FOCUS_SHIP_DIST)).toBe(AI_FOCUS_SHIP_DIST);
    expect(clampFollowDist(AI_FOCUS_PLANE_DIST)).toBe(AI_FOCUS_PLANE_DIST);
  });
});

describe("follow framing state machine", () => {
  it("starts at the ship stock with no kind memory or preset", () => {
    expect(initialFollowFraming()).toEqual({
      dist: FOLLOW_DIST_DEFAULT,
      preset: false,
      kind: null,
    });
    expect(stockFollowDist("ship")).toBe(FOLLOW_DIST_DEFAULT);
    expect(stockFollowDist("aircraft")).toBe(PLANE_FOLLOW_DIST_DEFAULT);
  });

  it("starts an aircraft pick at the aircraft stock", () => {
    // A null kind is a change too: the very first aircraft pick must not keep
    // the initial ship distance.
    expect(followFramingFor(initialFollowFraming(), "aircraft")).toEqual({
      dist: PLANE_FOLLOW_DIST_DEFAULT,
      preset: false,
      kind: "aircraft",
    });
  });

  it("switches to the aircraft stock when the target kind changes", () => {
    const ship = followFramingFor(initialFollowFraming(), "ship");
    const plane = followFramingFor(ship, "aircraft");
    expect(plane).toEqual({
      dist: PLANE_FOLLOW_DIST_DEFAULT,
      preset: false,
      kind: "aircraft",
    });
  });

  it("keeps the user wheel zoom on same-kind picks", () => {
    const zoomed = followFramingZoomed(
      followFramingFor(initialFollowFraming(), "ship"),
      140,
    );
    expect(followFramingFor(zoomed, "ship").dist).toBe(140);
    // A kind switch still resets to that kind's stock.
    expect(followFramingFor(zoomed, "aircraft").dist).toBe(
      PLANE_FOLLOW_DIST_DEFAULT,
    );
  });

  it("still resets after plane → clear → ship (the reported leak)", () => {
    // Plane framing is manual (no pending preset), the formation gap falls
    // back to the hull, the user clears the target, then picks a ship: the
    // kind memory must survive the clear so this lands on the ship stock.
    const plane = followFramingFor(initialFollowFraming(), "aircraft");
    const cleared = followFramingCleared(plane);
    expect(cleared.kind).toBe("aircraft");
    expect(followFramingFor(cleared, "ship").dist).toBe(FOLLOW_DIST_DEFAULT);
  });

  it("returns the same cleared state when nothing is pending", () => {
    const zoomed = followFramingZoomed(
      followFramingFor(initialFollowFraming(), "ship"),
      90,
    );
    expect(followFramingCleared(zoomed)).toBe(zoomed);
  });

  it("keeps the wheel zoom across a cleared target of the same kind", () => {
    const zoomed = followFramingZoomed(
      followFramingFor(initialFollowFraming(), "aircraft"),
      140,
    );
    const cleared = followFramingCleared(zoomed);
    expect(cleared.dist).toBe(140);
    expect(followFramingFor(cleared, "aircraft").dist).toBe(140);
    // A different kind still resets to that kind's stock.
    expect(followFramingFor(cleared, "ship").dist).toBe(FOLLOW_DIST_DEFAULT);
  });

  it("drops a pending AI preset when the target is cleared", () => {
    const focused = followFramingFor(
      initialFollowFraming(),
      "aircraft",
      AI_FOCUS_PLANE_DIST,
    );
    const cleared = followFramingCleared(focused);
    expect(cleared).toEqual({
      dist: PLANE_FOLLOW_DIST_DEFAULT,
      preset: false,
      kind: "aircraft",
    });
    expect(followFramingFor(cleared, "ship").dist).toBe(FOLLOW_DIST_DEFAULT);
  });

  it("lets a wheel zoom supersede a pending preset", () => {
    const focused = followFramingFor(
      initialFollowFraming(),
      "ship",
      AI_FOCUS_SHIP_DIST,
    );
    const zoomed = followFramingZoomed(focused, 120);
    expect(zoomed.preset).toBe(false);
    expect(followFramingFor(zoomed, "ship").dist).toBe(120);
  });
});

describe("applyFollowPose", () => {
  it("reproduces the stock chase framing at the default distance", () => {
    // yaw 0 (north-facing, model +Z = world −Z): the camera hangs RUN units
    // south of the ship and RISE units up — the legacy hard-coded pose.
    const cam = new THREE.Camera();
    const target = new THREE.Vector3(100, 0, -40);
    applyFollowPose(cam, target, 0, FOLLOW_DIST_DEFAULT);
    expect(cam.position.x).toBeCloseTo(100);
    expect(cam.position.y).toBeCloseTo(CHASE_RISE);
    expect(cam.position.z).toBeCloseTo(-40 + CHASE_RUN);
    expect(cam.position.distanceTo(target)).toBeCloseTo(FOLLOW_DIST_DEFAULT);
  });

  it("sits behind the stern for a west-facing ship (yaw π/2)", () => {
    // Forward = (sin yaw, 0, −cos yaw) = (1, 0, 0) → the chase axis points
    // −X, tilted up by the stock pitch.
    const cam = new THREE.Camera();
    const target = new THREE.Vector3(0, 0, 0);
    applyFollowPose(cam, target, Math.PI / 2, 100);
    expect(cam.position.x).toBeLessThan(0);
    expect(cam.position.y).toBeGreaterThan(0);
    expect(cam.position.z).toBeCloseTo(0);
    expect(cam.position.distanceTo(target)).toBeCloseTo(100);
  });

  it("keeps the chase pitch at any distance (zoom = pull along the axis)", () => {
    const cam = new THREE.Camera();
    const target = new THREE.Vector3(10, 0, 10);
    applyFollowPose(cam, target, 1.234, 300);
    const run = Math.hypot(cam.position.x - target.x, cam.position.z - target.z);
    const rise = cam.position.y - target.y;
    expect(rise / run).toBeCloseTo(CHASE_RISE / CHASE_RUN, 5);
    expect(cam.position.distanceTo(target)).toBeCloseTo(300);
  });

  it("does not mutate the target", () => {
    const cam = new THREE.Camera();
    const target = new THREE.Vector3(5, 1, 6);
    const before = target.clone();
    applyFollowPose(cam, target, 0.5, 200);
    expect(target.equals(before)).toBe(true);
  });
});
