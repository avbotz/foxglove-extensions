import { describe, expect, it } from "vitest";

import { Cruise, commandTargets, cruiseStep, withoutAxes } from "./cruise";
import {
  DEG,
  HEADING,
  HOLD,
  KEEP,
  POSITION,
  VELOCITY,
  WORLD,
  X,
  Y,
  YAW,
  Z,
  emptySetpoint,
} from "./msgs";
import { noTargets } from "./targets";

function cruise(values: Partial<Record<number, number>>, until?: number): Cruise {
  const velocity = noTargets();
  for (const [axis, value] of Object.entries(values)) {
    velocity[Number(axis)] = value;
  }
  return { velocity, frame: WORLD, until };
}

describe("cruiseStep", () => {
  it("streams the cruise with the stream timeout", () => {
    const { message, cruise: next } = cruiseStep(
      undefined,
      cruise({ [X]: 0.2, [Y]: 0, [YAW]: 0.1 }),
      0,
      0.5,
    );
    expect(message?.mode).toEqual([VELOCITY, VELOCITY, KEEP, KEEP, KEEP, VELOCITY]);
    expect(message?.velocity[X]).toBe(0.2);
    expect(message?.velocity_frame).toBe(WORLD);
    expect(message?.timeout).toBe(0.5);
    expect(next).toBeDefined();
  });

  it("holds once when it runs out", () => {
    const { message, cruise: next } = cruiseStep(undefined, cruise({ [Z]: -0.1 }, 1000), 1000, 0.5);
    expect(message?.mode).toEqual([KEEP, KEEP, HOLD, KEEP, KEEP, KEEP]);
    expect(next).toBeUndefined();
  });

  it("gives axes to manual input, x and y together", () => {
    const manual = emptySetpoint();
    manual.mode[X] = VELOCITY;
    manual.mode[Y] = VELOCITY;
    manual.velocity[X] = 0.3;
    manual.velocity_frame = HEADING;
    const { message, cruise: next } = cruiseStep(
      manual,
      cruise({ [X]: 0.2, [Y]: 0, [YAW]: 0.1 }),
      0,
      0.5,
    );
    expect(message?.mode).toEqual([VELOCITY, VELOCITY, KEEP, KEEP, KEEP, VELOCITY]);
    expect(message?.velocity[X]).toBe(0.3);
    expect(message?.velocity_frame).toBe(HEADING);
    expect(next?.velocity).toEqual([undefined, undefined, undefined, undefined, undefined, 0.1]);
  });
});

describe("commandTargets", () => {
  it("splits positions and velocities, filling the other of x and y with 0", () => {
    const positions = noTargets();
    positions[Z] = -1;
    const velocities = noTargets();
    velocities[X] = 0.25;
    velocities[YAW] = 10 * DEG;
    const result = commandTargets(positions, velocities, undefined);
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.positions?.mode).toEqual([KEEP, KEEP, POSITION, KEEP, KEEP, KEEP]);
    expect(result.velocity).toEqual([0.25, 0, undefined, undefined, undefined, 10 * DEG]);
  });

  it("refuses x and y in different modes, and nothing at all", () => {
    const positions = noTargets();
    positions[X] = 1;
    const velocities = noTargets();
    velocities[Y] = 0.1;
    expect(commandTargets(positions, velocities, [0, 0, 0, 0, 0, 0])).toHaveProperty("error");
    expect(commandTargets(noTargets(), noTargets(), undefined)).toHaveProperty("error");
  });
});

describe("withoutAxes", () => {
  it("drops x and y together and ends an empty cruise", () => {
    expect(withoutAxes(cruise({ [X]: 0.1, [Y]: 0, [Z]: 0.1 }), [Y])?.velocity).toEqual([
      undefined,
      undefined,
      0.1,
      undefined,
      undefined,
      undefined,
    ]);
    expect(withoutAxes(cruise({ [Z]: 0.1 }), [Z])).toBeUndefined();
  });
});
