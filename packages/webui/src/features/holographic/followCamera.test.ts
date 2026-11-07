/** Unit tests for the holographic map's follow-mode chase pose solver
 *  (framing state machine, pose stamping, damped chase pivot). */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  AI_FOCUS_PLANE_DIST,
  AI_FOCUS_SHIP_DIST,
  applyFollowPose,
  CHASE_RISE,
  CHASE_RUN,
  CHASE_SMOOTH_TAU_S,
  CHASE_SNAP_DIST,
  clampFollowDist,
  FOLLOW_DIST_DEFAULT,
  FOLLOW_DIST_MAX,
  FOLLOW_DIST_MIN,
  followFramingCleared,
  followFramingFor,
  followFramingZoomed,
  initialFollowFraming,
  PLANE_FOLLOW_DIST_DEFAULT,
  smoothChasePose,
  stockFollowDist,
  type ChaseSmoothState,
} from "./followCamera";
import { angleDiff } from "./trajectoryMath";

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

describe("smoothChasePose", () => {
  // dt that makes α exactly 0.5: 1 − e^(−τ·ln2/τ). Halfway per step keeps
  // every expectation below exact and frame-rate independent.
  const HALF_DT = CHASE_SMOOTH_TAU_S * Math.LN2;

  it("snaps onto the raw pose from a null state", () => {
    expect(smoothChasePose(null, { x: 10, y: 20, z: 30, yaw: 1 }, 100)).toEqual({
      state: { x: 10, y: 20, z: 30, yaw: 1, t: 100 },
      x: 10,
      y: 20,
      z: 30,
      yaw: 1,
      snapped: true,
    });
  });

  it("eases halfway per τ·ln2 step and converges toward the raw pose", () => {
    // Start pose and target sit ~102 units apart (inside the snap band:
    // a bigger step would be a cut) so the run is pure easing.
    const from = { x: 0, y: 0, z: 0, yaw: 0 };
    const target = { x: 80, y: 40, z: -50, yaw: 2.5 };
    // First frame: the null state snaps onto the raw start pose.
    const first = smoothChasePose(null, from, 0);
    expect(first.snapped).toBe(true);
    let state = first.state;
    // The next step halves the gap (α = 1 − e^(−τ·ln2/τ) = 0.5).
    let r = smoothChasePose(state, target, HALF_DT);
    expect(r.snapped).toBe(false);
    expect(r.x).toBeCloseTo(40, 9);
    expect(r.y).toBeCloseTo(20, 9);
    expect(r.z).toBeCloseTo(-25, 9);
    expect(r.yaw).toBeCloseTo(1.25, 9);
    // Every further step halves the remaining distance; after 40 steps the
    // residual is float noise. Same replay-time convergence at any fps.
    state = r.state;
    let r2 = r;
    for (let i = 2; i <= 40; i++) {
      r2 = smoothChasePose(state, target, i * HALF_DT);
      state = r2.state;
      expect(r2.snapped).toBe(false);
    }
    expect(r2.x).toBeCloseTo(80, 9);
    expect(r2.y).toBeCloseTo(40, 9);
    expect(r2.z).toBeCloseTo(-50, 9);
    expect(angleDiff(r2.yaw, 2.5)).toBeCloseTo(0, 9);
  });

  it("snaps when the pivot jumps beyond the snap threshold", () => {
    const state: ChaseSmoothState = { x: 0, y: 0, z: 0, yaw: 0, t: 10 };
    // A scrub / AI jump: far beyond CHASE_SNAP_DIST → raw pose, re-seeded.
    const far = smoothChasePose(
      state,
      { x: CHASE_SNAP_DIST + 1, y: 0, z: 0, yaw: 0.3 },
      10 + HALF_DT,
    );
    expect(far.snapped).toBe(true);
    expect(far.x).toBe(CHASE_SNAP_DIST + 1);
    expect(far.state).toEqual({
      x: CHASE_SNAP_DIST + 1,
      y: 0,
      z: 0,
      yaw: 0.3,
      t: 10 + HALF_DT,
    });
    // Exactly at the threshold is still motion (strictly farther snaps).
    const at = smoothChasePose(
      { ...state },
      { x: CHASE_SNAP_DIST, y: 0, z: 0, yaw: 0 },
      10 + HALF_DT,
    );
    expect(at.snapped).toBe(false);
    expect(at.x).toBeCloseTo(CHASE_SNAP_DIST / 2, 9);
  });

  it("snaps on a paused clock (dt = 0) and on backwards time", () => {
    const state: ChaseSmoothState = { x: 5, y: 6, z: 7, yaw: 0.2, t: 30 };
    const raw = { x: 6, y: 7, z: 8, yaw: 0.3 };
    // Same playhead (paused render tick): stamp the raw pose, don't ease.
    expect(smoothChasePose(state, raw, 30)).toEqual({
      state: { ...raw, t: 30 },
      x: 6,
      y: 7,
      z: 8,
      yaw: 0.3,
      snapped: true,
    });
    // A seek left of the state's playhead: snap, don't glide backwards.
    expect(smoothChasePose(state, raw, 20).snapped).toBe(true);
    expect(smoothChasePose(state, raw, 20).x).toBe(6);
  });

  it("takes the yaw through the shortest arc across the ±π seam", () => {
    // yaw −3 → +3: the raw difference is +6, the shortest arc is −0.283…
    // (a formation turning through south must rotate the short way). With
    // α = 0.5 the step lands exactly on −π — NOT on 0 (the naive lerp).
    const state: ChaseSmoothState = { x: 0, y: 0, z: 0, yaw: -3, t: 0 };
    const r = smoothChasePose(state, { x: 0, y: 0, z: 0, yaw: 3 }, HALF_DT);
    expect(r.snapped).toBe(false);
    expect(r.yaw).toBeCloseTo(-Math.PI, 6);
    // Convergence ends on an angle equivalent to the raw yaw.
    let s = r.state;
    let out = r;
    for (let i = 2; i <= 30; i++) {
      out = smoothChasePose(s, { x: 0, y: 0, z: 0, yaw: 3 }, i * HALF_DT);
      s = out.state;
    }
    expect(angleDiff(out.yaw, 3)).toBeCloseTo(0, 9);
  });
});
