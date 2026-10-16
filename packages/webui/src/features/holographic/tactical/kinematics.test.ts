/** Kinematics unit tests: the plan board's movement estimator (pure). */
import { describe, expect, it } from "vitest";
import { kinematicsOf, planLeg, wrapAngle, type Pose } from "./kinematics";

const kn30 = { topSpeedKn: 30, accelS: 30, turnRate: (2.8 * Math.PI) / 180 };
const dd40 = kinematicsOf(40, "Destroyer");
const bb25 = kinematicsOf(25, "Battleship");

const pose = (x: number, z: number, h: number): Pose => ({ at: { x, z }, heading: h });

describe("kinematicsOf", () => {
  it("clamps a corrupted speed field into a sane band", () => {
    expect(kinematicsOf(9999, "Cruiser").topSpeedKn).toBeLessThanOrEqual(60);
    expect(kinematicsOf(-5, "Cruiser").topSpeedKn).toBeGreaterThanOrEqual(5);
  });

  it("classes tune acceleration and turn rate", () => {
    expect(dd40.accelS).toBeLessThan(bb25.accelS);
    expect(dd40.turnRate).toBeGreaterThan(bb25.turnRate);
  });
});

describe("planLeg", () => {
  it("straight-ahead target: path stays on the line, time covers distance", () => {
    const plan = planLeg({ from: pose(0, 0, 0), to: { x: 0, z: 6000 }, kin: kn30 });
    // 30 kn ≈ 0.514 world units/s; 6000 units ≈ 180 km — cruise-dominated.
    const v = kn30.topSpeedKn * 0.514444 / 30;
    expect(plan.durS).toBeGreaterThan(6000 / v * 0.9);
    expect(plan.durS).toBeLessThan(6000 / (v * 0.5)); // never slower than half speed
    // No initial turn: every path point sits (near) on the z-axis.
    for (const p of plan.path) expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(plan.arriveHeading).toBeCloseTo(0, 5);
  });

  it("beam target curves the path toward the bearing", () => {
    // Heading north (0), target due east → the ship must arc clockwise.
    const plan = planLeg({ from: pose(0, 0, 0), to: { x: 2000, z: 0 }, kin: kn30 });
    expect(plan.path.length).toBeGreaterThan(2);
    // The arc bulges north of the straight line before settling on course.
    const maxZ = Math.max(...plan.path.map((p) => p.z));
    expect(maxZ).toBeGreaterThan(10);
    expect(plan.distance).toBeGreaterThan(2000);
  });

  it("zero-distance order is a no-op leg", () => {
    const plan = planLeg({ from: pose(5, 5, 1), to: { x: 5, z: 5 }, kin: kn30 });
    expect(plan.distance).toBe(0);
    expect(plan.path).toHaveLength(2);
    expect(plan.arriveHeading).toBeCloseTo(1, 6);
  });

  it("an arrival-heading constraint ends pointing as ordered", () => {
    const plan = planLeg({
      from: pose(0, 0, 0),
      to: { x: 0, z: 4000 },
      kin: kn30,
      arriveHeading: Math.PI / 2, // arrive driving east
    });
    expect(plan.arriveHeading).toBeCloseTo(Math.PI / 2, 5);
    // The terminal turn costs time and distance vs the free run.
    const free = planLeg({ from: pose(0, 0, 0), to: { x: 0, z: 4000 }, kin: kn30 });
    expect(plan.durS).toBeGreaterThan(free.durS);
    expect(plan.distance).toBeGreaterThan(free.distance);
    // ...and the path's tail swings off the approach line.
    const tail = plan.path[plan.path.length - 1];
    expect(tail.x).toBeGreaterThan(0);
  });

  it("a stop order pays deceleration time", () => {
    const cruise = planLeg({ from: pose(0, 0, 0), to: { x: 0, z: 4000 }, kin: kn30 });
    const stop = planLeg({
      from: pose(0, 0, 0),
      to: { x: 0, z: 4000 },
      kin: kn30,
      arriveHeading: 0,
      stop: true,
    });
    expect(stop.durS).toBeGreaterThan(cruise.durS);
  });

  it("path starts at the ship and ends at the target", () => {
    const plan = planLeg({ from: pose(-100, 40, 2), to: { x: 500, z: -300 }, kin: dd40 });
    expect(plan.path[0]).toEqual({ x: -100, z: 40 });
    const end = plan.path[plan.path.length - 1];
    expect(Math.hypot(end.x - 500, end.z + 300)).toBeLessThan(1);
  });
});

describe("wrapAngle", () => {
  it("wraps into (−π, π]", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(Math.PI / 2 + 2 * Math.PI)).toBeCloseTo(Math.PI / 2, 10);
  });
});
