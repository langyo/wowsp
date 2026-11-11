/** Interpolated recorder-camera pose (the 0x25 stream is ~10 samples/s).
 *
 * User report driving this: the follow camera twitched ("跟随镜头期间一直在
 * 抽搐") — applying the raw last sample made a 55 fps render follow a 10 fps
 * camera, and a rolling aircraft made consecutive samples jump. The pose
 * feeds BOTH the applied camera and the recorded aircraft placement.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { CameraSample } from "@/api";
import {
  applyRecordedCamera,
  cameraPoseAt,
  recordedCameraForward,
} from "./recordedCamera";

const frame = (
  time: number,
  x: number,
  y: number,
  z: number,
  rot?: [number, number, number, number],
  fov = 1,
): CameraSample => ({
  time,
  x,
  y,
  z,
  rotX: rot?.[0] ?? 0,
  rotY: rot?.[1] ?? 0,
  rotZ: rot?.[2] ?? 0,
  rotW: rot?.[3] ?? 1,
  fov,
});

describe("cameraPoseAt", () => {
  it("is null without a decoded camera stream", () => {
    expect(cameraPoseAt([], 10)).toBeNull();
  });

  it("clamps to the first frame before the stream starts", () => {
    const pose = cameraPoseAt([frame(5, 10, 20, 30), frame(6, 40, 50, 60)], 1);
    expect(pose).not.toBeNull();
    expect(pose!.x).toBe(10);
    expect(pose!.y).toBe(20);
    // Scene z mirrors the recorded z.
    expect(pose!.z).toBe(-30);
  });

  it("clamps to the last frame past the stream end", () => {
    const pose = cameraPoseAt([frame(5, 10, 20, 30), frame(6, 40, 50, 60)], 99);
    expect(pose!.x).toBe(40);
    expect(pose!.z).toBe(-60);
  });

  it("lerps position and fov between the bracketing frames", () => {
    const pose = cameraPoseAt(
      [frame(10, 0, 0, 0, undefined, 1), frame(20, 100, 200, 300, undefined, 2)],
      15,
    );
    expect(pose!.x).toBeCloseTo(50);
    expect(pose!.y).toBeCloseTo(100);
    expect(pose!.z).toBeCloseTo(-150);
    expect(pose!.fovRad).toBeCloseTo(1.5);
  });

  it("slerps the rotation instead of snapping to the previous sample", () => {
    // Two poses 90° apart around +Y: half-way is 45°, not the earlier frame.
    const qa = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      0,
    );
    const qb = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    const pose = cameraPoseAt(
      [
        frame(10, 0, 0, 0, [qa.x, qa.y, qa.z, qa.w]),
        frame(20, 0, 0, 0, [qb.x, qb.y, qb.z, qb.w]),
      ],
      15,
    );
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 4,
    );
    expect(pose!.qx).toBeCloseTo(expected.x, 6);
    expect(pose!.qy).toBeCloseTo(expected.y, 6);
    expect(pose!.qz).toBeCloseTo(expected.z, 6);
    expect(pose!.qw).toBeCloseTo(expected.w, 6);
  });
});

describe("recordedCameraForward / applyRecordedCamera", () => {
  it("reports the camera's -Z axis in scene coordinates", () => {
    const pose = cameraPoseAt([frame(10, 1, 2, 3)], 10)!;
    // Identity rotation → the camera looks down scene -Z.
    const fwd = recordedCameraForward(pose);
    expect(fwd.x).toBeCloseTo(0);
    expect(fwd.y).toBeCloseTo(0);
    expect(fwd.z).toBeCloseTo(-1);
  });

  it("applies position, quaternion and fov (radians → degrees)", () => {
    const pose = cameraPoseAt([frame(10, 1, 2, 3, undefined, Math.PI / 2)], 10)!;
    const cam = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      fov: 0,
      updateProjectionMatrix() {},
    };
    applyRecordedCamera(cam as unknown as THREE.PerspectiveCamera, pose);
    expect(cam.position.toArray()).toEqual([1, 2, -3]);
    expect(cam.fov).toBeCloseTo(90);
  });

  it("dollies back along the view axis without moving the recorded pose", () => {
    // The original-camera wheel zoom: the pose stays the stream's own (the
    // aircraft placement hangs off it), only the camera pulls back.
    const pose = cameraPoseAt([frame(10, 1, 2, 3)], 10)!;
    const cam = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      fov: 0,
      updateProjectionMatrix() {},
    };
    applyRecordedCamera(cam as unknown as THREE.PerspectiveCamera, pose, 100);
    // Identity rotation looks down scene −Z, so pulling back is +Z here.
    expect(cam.position.toArray()).toEqual([1, 2, -3 + 100]);
    // Zero dolly keeps the exact recorded pose.
    applyRecordedCamera(cam as unknown as THREE.PerspectiveCamera, pose, 0);
    expect(cam.position.toArray()).toEqual([1, 2, -3]);
  });
});