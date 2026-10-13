import { describe, expect, it } from "vitest";

import {
  Routine,
  RoutineForm,
  newRun,
  plan,
  preview,
  segmentAt,
  startPose,
  stopSetpoint,
  tick,
} from "./routines";
import { ControllerStatus, HOLD, KEEP, Odometry, POSITION, Six, VELOCITY, X, Y, Z } from "../../common/msgs";

const start: Six<number> = [1, 2, -1.5, 0, 0, 0.5];

function planned(form: Partial<RoutineForm>): Routine {
  const result = plan(
    { kind: "step", axis: "z", amplitude: 0.5, hold: 2, settle: 1, cycles: 1, ...form },
    start,
  );
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}

describe("plan", () => {
  it("steps out, back, the other way and back on one axis", () => {
    const routine = planned({ kind: "step", axis: "z", amplitude: 0.5, cycles: 2 });
    expect(routine.segments).toHaveLength(8);
    expect(routine.segments.map((s) => s.position[Z])).toEqual([-1, -1.5, -2, -1.5, -1, -1.5, -2, -1.5]);
    expect(routine.segments[0]?.mode).toEqual([KEEP, KEEP, POSITION, KEEP, KEEP, KEEP]);
    expect(routine.duration).toBe(16);
    expect(segmentAt(routine, 3)).toBe(1);
    expect(segmentAt(routine, 16)).toBeUndefined();
  });

  it("moves x and y together", () => {
    const routine = planned({ kind: "step", axis: "x", amplitude: 1 });
    const first = routine.segments[0]!;
    expect(first.mode.slice(0, 2)).toEqual([POSITION, POSITION]);
    expect(first.position.slice(0, 2)).toEqual([2, 2]);
  });

  it("cruises both ways with a stop between, streaming the velocity", () => {
    const routine = planned({ kind: "cruise", axis: "yaw", amplitude: 0.3, hold: 4, settle: 2 });
    expect(routine.segments.map((s) => s.label)).toEqual([
      "yaw +0.3 rad/s",
      "stop and hold",
      "yaw -0.3 rad/s",
      "stop and hold",
    ]);
    expect(routine.segments[0]?.mode[5]).toBe(VELOCITY);
    expect(routine.segments[1]?.mode[5]).toBe(HOLD);
    expect(routine.duration).toBe(12);
  });

  it("walks a square forward then left, and previews its corners", () => {
    const routine = planned({ kind: "square", amplitude: 1, hold: 3 });
    expect(routine.segments.map((s) => [s.position[X], s.position[Y]])).toEqual([
      [2, 2],
      [2, 3],
      [1, 3],
      [1, 2],
    ]);
    expect(preview(routine)).toHaveLength(5);
    expect(preview(planned({ kind: "hold" }))).toEqual([]);
  });

  it("refuses what the vehicle should not do", () => {
    expect(plan({ kind: "step", axis: "roll", amplitude: 1, hold: 2, settle: 1, cycles: 1 }, start)).toHaveProperty("error");
    expect(plan({ kind: "cruise", axis: "roll", amplitude: 0.1, hold: 2, settle: 1, cycles: 1 }, start)).toHaveProperty("error");
    expect(plan({ kind: "step", axis: "z", amplitude: 1.4, hold: 2, settle: 1, cycles: 1 }, start)).toHaveProperty("error");
    expect(plan({ kind: "hold", axis: "z", amplitude: 0, hold: 0.5, settle: 1, cycles: 1 }, start)).toHaveProperty("error");
    expect(plan({ kind: "step", axis: "z", amplitude: 0.5, hold: 2, settle: 1, cycles: 1.5 }, start)).toHaveProperty("error");
  });
});

function status(overrides: Partial<ControllerStatus> = {}): ControllerStatus {
  return {
    header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "" },
    mode: [POSITION, POSITION, POSITION, KEEP, KEEP, POSITION],
    altitude: false,
    target: [5, 6, -2, 0, 0, 1],
    reference_position: [],
    reference_velocity: [],
    reference_acceleration: [],
    wrench_command: [],
    wrench_achieved: [],
    integral: [],
    disturbance: [],
    thruster_force: [],
    thruster_command: [],
    thruster_saturated: [],
    thruster_health: [],
    axis_controllable: [],
    killed: false,
    armed: true,
    failsafe: false,
    imu_ok: true,
    dvl_ok: true,
    depth_ok: true,
    altitude_ok: false,
    state_age: 0,
    command_id: 0n,
    command_rejected: false,
    ...overrides,
  };
}

describe("startPose", () => {
  it("takes POSITION targets and measured values elsewhere, never an altitude target", () => {
    expect(startPose(status(), start)).toEqual([5, 6, -2, 0, 0, 1]);
    expect(startPose(status({ altitude: true }), start)[Z]).toBe(-1.5);
  });
});

const odom = {} as Odometry;

describe("tick", () => {
  it("sends each segment once, streams velocities, and completes", () => {
    const routine = planned({ kind: "cruise", axis: "x", amplitude: 0.2, hold: 1, settle: 1 });
    const run = newRun(routine, 0);
    const first = tick(run, 0, status(), odom);
    expect(first.kind).toBe("send");
    if (first.kind !== "send") {
      throw new Error();
    }
    expect(first.message.timeout).toBe(0.5);
    expect(first.message.id).not.toBe(0);
    expect(tick(run, 100, status(), odom).kind).toBe("send"); // streamed again
    const stopAction = tick(run, 1100, status(), odom);
    expect(stopAction.kind).toBe("send");
    expect(tick(run, 1200, status(), odom).kind).toBe("none"); // a HOLD goes once
    expect(tick(run, 4000, status(), odom)).toMatchObject({ kind: "finish", status: "complete" });
  });

  it("aborts, holding, when the vehicle is no longer fit, and without holding when killed", () => {
    const run = newRun(planned({ kind: "hold", hold: 10 }), 0);
    expect(tick(run, 0, status({ armed: false }), odom)).toMatchObject({
      kind: "finish",
      status: "aborted",
      hold: true,
    });
    expect(tick(run, 0, status({ killed: true }), odom)).toMatchObject({ hold: false });
    expect(tick(run, 0, status(), undefined)).toMatchObject({ status: "aborted" });
  });

  it("aborts once another command source is acknowledged", () => {
    const run = newRun(planned({ kind: "hold", hold: 10 }), 0);
    const sent = tick(run, 0, status({ command_id: 77n }), odom);
    expect(sent.kind).toBe("send");
    // An old id before ours is acknowledged is fine...
    expect(tick(run, 50, status({ command_id: 77n }), odom).kind).toBe("none");
    const ours = sent.kind === "send" ? sent.message.id : 0;
    expect(tick(run, 100, status({ command_id: BigInt(ours) }), odom).kind).toBe("none");
    // ...a new one after it is not.
    expect(tick(run, 150, status({ command_id: 0n }), odom)).toMatchObject({
      kind: "finish",
      status: "aborted",
      hold: true,
    });
  });
});

describe("stopSetpoint", () => {
  it("holds every axis and levels roll and pitch", () => {
    const message = stopSetpoint(0.1, 0);
    expect(message.mode).toEqual([HOLD, HOLD, HOLD, POSITION, POSITION, HOLD]);
    expect(message.position[3]).toBe(0.1);
  });
});
