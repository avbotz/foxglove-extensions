import { describe, expect, it } from "vitest";

import { fromPilot, noTargets, positionSetpoint, stepTargets, toPilot } from "./targets";
import { ManualMode, stepEdges, zeros } from "./teleop";
import { DEG, KEEP, PITCH, POSITION, ROLL, Six, X, Y, YAW, Z } from "../../common/msgs";

const sizes: Six<number> = [0.25, 0.25, 0.1, 5 * DEG, 5 * DEG, 15 * DEG];

function counts(values: Partial<Record<number, number>>): Six<number> {
  const result = zeros();
  for (const [axis, value] of Object.entries(values)) {
    result[Number(axis)] = value!;
  }
  return result;
}

describe("stepTargets", () => {
  const base: Six<number> = [1, 2, -1, 0, 0, 90 * DEG];

  it("steps x and y together along the heading", () => {
    const forward = stepTargets(counts({ [X]: 1 }), base, sizes);
    // Facing odom +y, forward is +y.
    expect(forward[X]).toBeCloseTo(1);
    expect(forward[Y]).toBeCloseTo(2.25);
    expect(forward[Z]).toBeUndefined();
    const right = stepTargets(counts({ [Y]: 1 }), base, sizes);
    // ...and right is +x.
    expect(right[X]).toBeCloseTo(1.25);
    expect(right[Y]).toBeCloseTo(2);
  });

  it("steps in operator directions", () => {
    const up = stepTargets(counts({ [Z]: 1, [PITCH]: 1, [YAW]: 1, [ROLL]: 1 }), base, sizes);
    expect(up[Z]).toBeCloseTo(-0.9); // up
    expect(up[PITCH]).toBeCloseTo(-5 * DEG); // nose up
    expect(up[YAW]).toBeCloseTo(75 * DEG); // right, clockwise
    expect(up[ROLL]).toBeCloseTo(5 * DEG); // right
    expect(up[X]).toBeUndefined();
  });
});

describe("positionSetpoint", () => {
  it("sends POSITION only where there is a target", () => {
    const targets = noTargets();
    targets[Z] = -1.5;
    targets[YAW] = 200 * DEG;
    const result = positionSetpoint(targets, undefined);
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.message.mode).toEqual([KEEP, KEEP, POSITION, KEEP, KEEP, POSITION]);
    expect(result.message.position[YAW]).toBeCloseTo(-160 * DEG); // wrapped
  });

  it("fills the other of x and y from the base", () => {
    const targets = noTargets();
    targets[X] = 3;
    expect(positionSetpoint(targets, undefined)).toHaveProperty("error");
    const result = positionSetpoint(targets, [1, 2, 0, 0, 0, 0]);
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.message.mode.slice(0, 2)).toEqual([POSITION, POSITION]);
    expect(result.message.position.slice(0, 2)).toEqual([3, 2]);
  });

  it("refuses an empty or non-numeric target", () => {
    expect(positionSetpoint(noTargets(), undefined)).toHaveProperty("error");
    const targets = noTargets();
    targets[Z] = NaN;
    expect(positionSetpoint(targets, undefined)).toHaveProperty("error");
  });
});

describe("pilot units", () => {
  it("shows depth down and pitch nose up, in degrees", () => {
    expect(toPilot(Z, -1.5)).toBe(1.5);
    expect(toPilot(PITCH, -10 * DEG)).toBeCloseTo(10);
    expect(toPilot(YAW, 90 * DEG)).toBeCloseTo(90);
    expect(fromPilot(PITCH, toPilot(PITCH, 0.3))).toBeCloseTo(0.3);
    expect(Object.is(toPilot(Z, 0), 0)).toBe(true);
  });
});

describe("stepEdges", () => {
  const manual: Six<ManualMode> = ["step", "step", "rate", "step", "step", "step"];
  const armed: Six<boolean> = [true, true, true, true, true, true];

  it("steps once per push past the threshold", () => {
    const pushed = stepEdges(counts({ [YAW]: 0.8, [Z]: 1 }), armed, manual);
    expect(pushed.counts).toEqual(counts({ [YAW]: 1 })); // z is a rate axis
    const held = stepEdges(counts({ [YAW]: 0.9 }), pushed.armed, manual);
    expect(held.counts).toEqual(zeros());
    const halfway = stepEdges(counts({ [YAW]: 0.4 }), held.armed, manual);
    expect(stepEdges(counts({ [YAW]: 0.9 }), halfway.armed, manual).counts).toEqual(zeros());
    const released = stepEdges(counts({ [YAW]: 0.1 }), halfway.armed, manual);
    expect(stepEdges(counts({ [YAW]: -0.7 }), released.armed, manual).counts).toEqual(
      counts({ [YAW]: -1 }),
    );
  });
});
