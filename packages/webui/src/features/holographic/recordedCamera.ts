/**
 * Interpolated recorder-camera pose at the playhead (0x25 CameraSample).
 *
 * The decoded camera stream is ~10 samples/second: applying the last
 * sample at-or-before t directly either stutters the view (a 55 fps
 * render showing a 10 fps camera) or twitches when the followed aircraft
 * rolls, so the ORIGINAL-camera view and the recorded aircraft placement
 * both consume this interpolated pose instead. Position and fov lerp;
 * the quaternion slerps (normalized) — both are pure function outputs, so
 * the map can call this every frame and every marker pass.
 *
 * Scene coordinates: the scene mirrors the recorded z (z' = -z), exactly
 * like the camera application in HolographicMap.
 */
import * as THREE from "three";
import type { CameraSample } from "@/api";
import type { MapInternals } from "./mapInternals";

export interface RecordedCameraPose {
  /** Scene-space position (recorded z already mirrored). */
  x: number;
  y: number;
  z: number;
  /** Scene-space rotation quaternion (camera local -Z is the view axis). */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Vertical field of view in RADIANS (the decoder's unit). */
  fovRad: number;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** Last camera frame at or before t, interpolated toward the next frame. */
export function cameraPoseAt(
  frames: readonly CameraSample[],
  t: number,
): RecordedCameraPose | null {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = frames[lo];
  const b = lo + 1 < frames.length ? frames[lo + 1] : null;
  let x = a.x;
  let y = a.y;
  let z = a.z;
  let fov = a.fov;
  if (b && b.time > a.time && t > a.time) {
    const k = Math.min(1, (t - a.time) / (b.time - a.time));
    x = a.x + (b.x - a.x) * k;
    y = a.y + (b.y - a.y) * k;
    z = a.z + (b.z - a.z) * k;
    fov = a.fov + (b.fov - a.fov) * k;
    _qa.set(a.rotX, a.rotY, a.rotZ, a.rotW);
    _qb.set(b.rotX, b.rotY, b.rotZ, b.rotW);
    _qa.slerp(_qb, k);
  } else {
    _qa.set(a.rotX, a.rotY, a.rotZ, a.rotW);
  }
  _qa.normalize();
  return {
    x,
    y,
    z: -z, // scene mirror
    qx: _qa.x,
    qy: _qa.y,
    qz: _qa.z,
    qw: _qa.w,
    fovRad: fov,
  };
}

/** `cameraPoseAt` for a MapInternals context (the marker pass's entry). */
export function recordedCameraAt(
  ctx: Pick<MapInternals, "props">,
  t: number,
): RecordedCameraPose | null {
  return cameraPoseAt(ctx.props.cameraFrames, t);
}

const _fwd = new THREE.Vector3();

/** Camera forward (local -Z) in scene coordinates. */
export function recordedCameraForward(pose: RecordedCameraPose): {
  x: number;
  y: number;
  z: number;
} {
  _fwd.set(0, 0, -1).applyQuaternion(
    _qa.set(pose.qx, pose.qy, pose.qz, pose.qw),
  );
  return { x: _fwd.x, y: _fwd.y, z: _fwd.z };
}

/** Extra downward pitch (radians) of the recorded PLANE view: the camera
 *  sits `PLANE_VIEW_ABOVE` over the squadron and this tilts it down so the
 *  formation reads in the middle of the frame instead of hugging the bottom
 *  edge (user report). CAMERA ONLY: the lens placement stays level on the
 *  aircraft heading so the wedge keeps its recorded altitude (pitching the
 *  placement too sank it below the sea on low-altitude recordings). */
export const PLANE_VIEW_PITCH = 0.32;

const _qy = new THREE.Quaternion();
const _qx = new THREE.Quaternion();

/** Rotate a recorded pose about the SCENE Y axis so the camera's horizontal
 *  forward is `headingYaw` (the map's yaw convention: scene fwd =
 *  (sin yaw, ·, −cos yaw)). The recorded pitch/roll survive — the plane
 *  camera keeps its banking, only the view DIRECTION is locked to the
 *  aircraft's own heading (user report: the camera did not always face where
 *  the squadron was actually flying). */
export function alignPoseHeading(
  pose: RecordedCameraPose,
  headingYaw: number,
): RecordedCameraPose {
  const f = recordedCameraForward(pose);
  const camYaw = Math.atan2(f.x, -f.z);
  let delta = headingYaw - camYaw;
  // Shortest way round.
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  if (Math.abs(delta) < 1e-5) return pose;
  // A positive scene-Y rotation turns the heading yaw DOWN (scene fwd =
  // (sin yaw, ·, −cos yaw)), so the correction is −delta.
  _qy.setFromAxisAngle(_Y_AXIS, -delta);
  _qx.set(pose.qx, pose.qy, pose.qz, pose.qw);
  const q = _qy.multiply(_qx).normalize();
  return { ...pose, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
}

/** Temporary free-look offset (hold-RMB): yaw about the camera's local Y,
 *  then pitch about its local X. Applied on top of the stamped pose, so
 *  releasing the button snaps straight back to the recorded view. */
export function withLookOffset(
  pose: RecordedCameraPose,
  yaw: number,
  pitch: number,
): RecordedCameraPose {
  if (!yaw && !pitch) return pose;
  _qy.setFromAxisAngle(_Y_AXIS, -yaw);
  _qx.setFromAxisAngle(_X_AXIS, -pitch);
  _qy.multiply(_qx);
  const base = new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw);
  const q = base.multiply(_qy).normalize();
  return { ...pose, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
}

const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _X_AXIS = new THREE.Vector3(1, 0, 0);

/** Apply a recorder pose to a three camera (scene mirrors recorded z).
 *  `dolly` pulls the camera BACK along its own view axis without moving the
 *  recorded pose itself — the aircraft placement hangs off the pose, so the
 *  wheel zoom changes how far the squadron reads rather than dragging it
 *  along (the in-game plane camera zooms the same way). */
export function applyRecordedCamera(
  cam: {
    position: { set(x: number, y: number, z: number): void };
    quaternion: { set(x: number, y: number, z: number, w: number): void };
    fov: number;
    updateProjectionMatrix(): void;
  },
  pose: RecordedCameraPose,
  dolly = 0,
): void {
  if (dolly) {
    const f = recordedCameraForward(pose);
    cam.position.set(
      pose.x - f.x * dolly,
      pose.y - f.y * dolly,
      pose.z - f.z * dolly,
    );
  } else {
    cam.position.set(pose.x, pose.y, pose.z);
  }
  cam.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
  cam.fov = (pose.fovRad * 180) / Math.PI;
  cam.updateProjectionMatrix();
}