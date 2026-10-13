import { describe, expect, it } from "vitest";

import { SignalBuffer, eulerRates, measuredState, rotate, signalsOf, viewSignals } from "./signals";
import { DEG, Odometry } from "../../common/msgs";

function odometry(yaw: number, linear = { x: 1, y: 0, z: 0 }, angular = { x: 0, y: 0, z: 0 }): Odometry {
  return {
    pose: {
      pose: {
        position: { x: 1, y: 2, z: -1 },
        orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
      },
    },
    twist: { twist: { linear, angular } },
  };
}

describe("frames", () => {
  it("rotates a body velocity into odom", () => {
    const [x, y] = rotate(odometry(90 * DEG).pose.pose.orientation, { x: 1, y: 0, z: 0 });
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
  });

  it("turns body rates into Euler rates", () => {
    expect(eulerRates(0, 0, { x: 0.1, y: 0.2, z: 0.3 })).toEqual([0.1, 0.2, 0.3]);
    const [, pitchRate, yawRate] = eulerRates(90 * DEG, 0, { x: 0, y: 0, z: 1 });
    // Rolled 90° right, body yaw rate is a nose-down pitch rate.
    expect(pitchRate).toBeCloseTo(-1);
    expect(yawRate).toBeCloseTo(0);
  });

  it("measures z as the altitude while the controller holds altitude", () => {
    const status = { altitude: true } as never;
    expect(measuredState(odometry(0), status, 2.5).pose[2]).toBe(2.5);
    expect(measuredState(odometry(0), undefined, 2.5).pose[2]).toBe(-1);
  });
});

describe("signalsOf", () => {
  it("derives the tracking error, wrapping angles", () => {
    const measured = measuredState(odometry(170 * DEG), undefined, undefined);
    const status = {
      target: [0, 0, 0, 0, 0, 0],
      reference_position: [1.5, 2, -1, 0, 0, -170 * DEG],
      reference_velocity: [0, 0, 0, 0, 0, 0],
      reference_acceleration: [0, 0, 0, 0, 0, 0],
      wrench_command: [0, 0, 0, 0, 0, 0],
      wrench_achieved: [0, 0, 0, 0, 0, 0],
      integral: [0, 0, 0, 0, 0, 0],
      disturbance: [0, 0, 0, 0, 0, 0],
      thruster_command: new Array(8).fill(0),
      thruster_force: new Array(8).fill(NaN),
      state_age: 0.02,
    } as never;
    const signals = signalsOf(status, measured, undefined);
    expect(signals["x.tracking_error"]).toBeCloseTo(0.5);
    expect(signals["yaw.tracking_error"]).toBeCloseTo(20 * DEG);
    expect(signals["thruster_0.force"]).toBeUndefined(); // not finite
    expect(signals["x.velocity"]).toBeCloseTo(Math.cos(170 * DEG));
  });

  it("names a view's signals per axis", () => {
    expect(viewSignals("tracking", "yaw", [])).toEqual(["yaw.tracking_error"]);
    expect(viewSignals("custom", "x", ["altitude"])).toEqual(["altitude"]);
  });
});

describe("SignalBuffer", () => {
  it("keeps a window of samples and looks values up by time", () => {
    const buffer = new SignalBuffer(10);
    buffer.add(0, { a: 1 });
    buffer.add(5, { a: 2, b: 3 });
    buffer.add(12, { a: 4 });
    expect(buffer.series("a")?.v).toEqual([2, 4]);
    expect(buffer.latestValue("b")).toBe(3);
    expect(buffer.valueAt("a", 7)).toBe(2);
    expect(buffer.valueAt("a", 1)).toBeUndefined();
    expect(buffer.csv(["a", "b"])).toBe("t,a,b\n-7.0000,2,3\n0.0000,4,\n");
    buffer.clear();
    expect(buffer.names()).toEqual([]);
  });
});
