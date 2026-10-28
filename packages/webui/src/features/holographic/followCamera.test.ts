/** Unit tests for the holographic map's follow-mode chase pose solver. */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyFollowPose,
  CHASE_RISE,
  CHASE_RUN,
  clampFollowDist,
  FOLLOW_DIST_DEFAULT,
  FOLLOW_DIST_MAX,
  FOLLOW_DIST_MIN,
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
