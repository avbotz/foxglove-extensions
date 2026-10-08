import { describe, expect, it } from "vitest";

import {
  DEG,
  EFFORT,
  HEADING,
  HOLD,
  KEEP,
  PITCH,
  POSITION,
  ROLL,
  VELOCITY,
  X,
  Y,
  YAW,
  Z,
} from "./msgs";
import {
  NOT_STREAMING,
  TeleopSettings,
  applyDeadzone,
  gamepadInput,
  DEFAULT_GAMEPAD_MAPPING,
  keyboardInput,
  releaseStep,
  teleopStep,
  zeros,
} from "./teleop";

const settings: TeleopSettings = {
  manual: ["rate", "rate", "rate", "rate", "rate", "rate"],
  command: "velocity",
  maxVelocity: [0.3, 0.3, 0.2, 20 * DEG, 20 * DEG, 30 * DEG],
  maxEffort: [15, 15, 15, 3, 3, 3],
  velocityFrame: HEADING,
  timeout: 0.5,
  levelOnRelease: false,
};

function input(values: Partial<Record<number, number>>): number[] {
  const result = zeros();
  for (const [axis, value] of Object.entries(values)) {
    result[Number(axis)] = value!;
  }
  return result;
}

describe("teleopStep", () => {
  it("sends nothing while idle", () => {
    expect(teleopStep(zeros(), NOT_STREAMING, settings).message).toBeUndefined();
  });

  it("streams a driven axis and keeps x and y in one mode", () => {
    const { message, streaming } = teleopStep(input({ [X]: 0.5 }), NOT_STREAMING, settings);
    expect(message?.mode).toEqual([VELOCITY, VELOCITY, KEEP, KEEP, KEEP, KEEP]);
    expect(message?.velocity[X]).toBeCloseTo(0.15);
    expect(Object.is(message?.velocity[Y], 0)).toBe(true);
    expect(message?.timeout).toBe(0.5);
    expect(streaming).toEqual([true, true, false, false, false, false]);
  });

  it("converts operator directions to body FLU", () => {
    const { message } = teleopStep(
      input({ [Y]: 1, [Z]: 1, [ROLL]: 1, [PITCH]: 1, [YAW]: 1 }),
      NOT_STREAMING,
      settings,
    );
    expect(message?.velocity[Y]).toBeCloseTo(-0.3); // right is -y
    expect(message?.velocity[Z]).toBeCloseTo(0.2); // up is +z
    expect(message?.velocity[ROLL]).toBeCloseTo(20 * DEG); // roll right is +roll
    expect(message?.velocity[PITCH]).toBeCloseTo(-20 * DEG); // nose up is -pitch
    expect(message?.velocity[YAW]).toBeCloseTo(-30 * DEG); // yaw right is -yaw
  });

  it("holds an axis once when it is let go, then goes quiet", () => {
    const driving = teleopStep(input({ [X]: 1, [YAW]: 1 }), NOT_STREAMING, settings);
    const yawOnly = teleopStep(input({ [YAW]: 1 }), driving.streaming, settings);
    expect(yawOnly.message?.mode).toEqual([HOLD, HOLD, KEEP, KEEP, KEEP, VELOCITY]);
    const released = teleopStep(zeros(), yawOnly.streaming, settings);
    expect(released.message?.mode).toEqual([KEEP, KEEP, KEEP, KEEP, KEEP, HOLD]);
    expect(teleopStep(zeros(), released.streaming, settings).message).toBeUndefined();
  });

  it("levels roll and pitch on release when asked", () => {
    const driving = teleopStep(input({ [ROLL]: 1, [PITCH]: -1, [Z]: 1 }), NOT_STREAMING, settings);
    const released = releaseStep(driving.streaming, { ...settings, levelOnRelease: true });
    expect(released.message?.mode).toEqual([KEEP, KEEP, HOLD, POSITION, POSITION, KEEP]);
    expect(released.message?.position).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("pushes open loop in effort mode", () => {
    const { message } = teleopStep(input({ [Z]: -1, [YAW]: 0.5 }), NOT_STREAMING, {
      ...settings,
      command: "effort",
    });
    expect(message?.mode).toEqual([KEEP, KEEP, EFFORT, KEEP, KEEP, EFFORT]);
    expect(message?.effort[Z]).toBeCloseTo(-15);
    expect(message?.effort[YAW]).toBeCloseTo(-1.5);
  });

  it("clamps and ignores non-finite input", () => {
    const { message } = teleopStep(input({ [X]: 3, [Z]: NaN }), NOT_STREAMING, settings);
    expect(message?.velocity[X]).toBeCloseTo(0.3);
    expect(message?.mode[Z]).toBe(KEEP);
  });
});

describe("keyboardInput", () => {
  it("adds bindings and cancels opposites", () => {
    expect(keyboardInput(new Set(["KeyW", "KeyD", "KeyI"]))).toEqual([1, 1, 0, 0, -1, 0]);
    expect(keyboardInput(new Set(["KeyW", "KeyS", "KeyQ"]))).toEqual([0, 0, 0, 0, 0, -1]);
  });
});

describe("gamepadInput", () => {
  const pad = (axes: number[], pressed: Record<number, number> = {}) => ({
    axes,
    buttons: Array.from({ length: 17 }, (_, index) => ({ value: pressed[index] ?? 0 })),
  });

  it("reads the default mapping in operator directions", () => {
    // Left stick up and right, right stick down, RT half, RB.
    const value = gamepadInput(pad([0.5, -1, 0, 1], { 5: 1, 7: 0.5 }), DEFAULT_GAMEPAD_MAPPING, 0);
    expect(value).toEqual([1, 0, -1, 1, 0.5, 0.5]);
  });

  it("applies the deadzone and inversion", () => {
    const mapping = DEFAULT_GAMEPAD_MAPPING.map((m) => ({ ...m }));
    mapping[X]!.invert = true;
    const value = gamepadInput(pad([0.05, -0.55, 0, 0]), mapping, 0.1);
    expect(value[X]).toBeCloseTo(-0.5);
    expect(value[YAW]).toBe(0);
  });
});

describe("applyDeadzone", () => {
  it("is zero inside and spans [-1, 1] outside", () => {
    expect(applyDeadzone(0.1, 0.1)).toBe(0);
    expect(applyDeadzone(-1, 0.1)).toBe(-1);
    expect(applyDeadzone(0.55, 0.1)).toBeCloseTo(0.5);
    expect(applyDeadzone(NaN, 0.1)).toBe(0);
  });
});

describe("manual modes", () => {
  it("only streams rate axes, and releases an axis switched away from rate", () => {
    const manual = ["rate", "rate", "lock", "step", "rate", "rate"] as TeleopSettings["manual"];
    const driving = teleopStep(input({ [X]: 1, [Z]: 1, [ROLL]: 1 }), NOT_STREAMING, {
      ...settings,
      manual,
    });
    expect(driving.message?.mode).toEqual([VELOCITY, VELOCITY, KEEP, KEEP, KEEP, KEEP]);
    const locked = teleopStep(input({ [X]: 1 }), driving.streaming, {
      ...settings,
      manual: ["lock", "lock", "lock", "step", "rate", "rate"],
    });
    expect(locked.message?.mode).toEqual([HOLD, HOLD, KEEP, KEEP, KEEP, KEEP]);
  });
});
