// The Motion Setpoint panel's form and the MotionSetpoint it sends. No React or Foxglove here,
// so it can be unit tested.

import {
  AXIS_NAMES,
  AxisMode,
  DEG,
  EFFORT,
  KEEP,
  MotionSetpoint,
  NUM_DOF,
  POSITION,
  ROLL,
  Six,
  VELOCITY,
  VelocityFrame,
  X,
  Y,
  YAW,
  Z,
  emptySetpoint,
  wrapAngle,
} from "../../common/msgs";

/** One axis of the form. Angles and angular rates are in degrees; the message is in radians. */
export type AxisRow = { mode: AxisMode; position: number; velocity: number; effort: number };

/**
 * How POSITION values are read:
 * - absolute: odom coordinates
 * - relative: offsets from the controller's current target, along odom axes
 * - heading: offsets from the current target, x forward and y left along its heading
 */
export type PositionFrame = "absolute" | "relative" | "heading";

export type SetpointForm = {
  rows: Six<AxisRow>;
  positionFrame: PositionFrame;
  velocityFrame: VelocityFrame;
  /** z POSITION is altitude above the bottom from the DVL. */
  altitude: boolean;
  /** [s] VELOCITY and EFFORT axes hold after this; 0 latches them. */
  timeout: number;
};

/** What relative targets are measured from: ControllerStatus.target and .altitude. */
export type CurrentTarget = { target: ArrayLike<number>; altitude: boolean };

export type BuildResult = { message: MotionSetpoint; warnings: string[] } | { error: string };

export function isAngle(axis: number): boolean {
  return axis >= ROLL;
}

export function emptyRow(): AxisRow {
  return { mode: KEEP, position: 0, velocity: 0, effort: 0 };
}

export function defaultForm(): SetpointForm {
  return {
    rows: [emptyRow(), emptyRow(), emptyRow(), emptyRow(), emptyRow(), emptyRow()],
    positionFrame: "absolute",
    velocityFrame: 0,
    altitude: false,
    timeout: 5,
  };
}

export function buildSetpoint(form: SetpointForm, current: CurrentTarget | undefined): BuildResult {
  const { rows } = form;
  if (rows[X].mode !== rows[Y].mode) {
    return { error: "x and y must share a mode" };
  }
  if (rows.every((row) => row.mode === KEEP)) {
    return { error: "Every axis is Keep: nothing to send" };
  }
  if (!(form.timeout >= 0)) {
    return { error: "Timeout must be 0 or more" };
  }

  const message = emptySetpoint();
  const warnings: string[] = [];
  const zPosition = rows[Z].mode === POSITION;
  message.velocity_frame = form.velocityFrame;
  message.altitude = zPosition && form.altitude;
  message.timeout = form.timeout;

  for (let axis = 0; axis < NUM_DOF; axis++) {
    const row = rows[axis]!;
    const scale = isAngle(axis) ? DEG : 1;
    message.mode[axis] = row.mode;
    message.position[axis] = row.position * scale;
    message.velocity[axis] = row.velocity * scale;
    message.effort[axis] = row.effort;
    const value =
      row.mode === POSITION ? row.position : row.mode === VELOCITY ? row.velocity : row.effort;
    if (
      (row.mode === POSITION || row.mode === VELOCITY || row.mode === EFFORT) &&
      !Number.isFinite(value)
    ) {
      return { error: `${AXIS_NAMES[axis]!} needs a number` };
    }
  }

  const positionAxes = rows.flatMap((row, axis) => (row.mode === POSITION ? [axis] : []));
  if (form.positionFrame !== "absolute" && positionAxes.length > 0) {
    if (current == undefined) {
      return { error: "Relative targets are measured from control/status, and none has arrived" };
    }
    if (zPosition && form.altitude !== current.altitude) {
      return {
        error: `The controller's z is ${current.altitude ? "an altitude" : "a depth"}: a relative z needs the same reference`,
      };
    }
    const base = (axis: number) => current.target[axis] ?? 0;
    const offset = message.position.slice() as Six<number>;
    for (const axis of positionAxes) {
      message.position[axis] = base(axis) + offset[axis]!;
    }
    if (form.positionFrame === "heading" && rows[X].mode === POSITION) {
      const yaw = base(YAW);
      const [dx, dy] = [offset[X], offset[Y]];
      message.position[X] = base(X) + Math.cos(yaw) * dx - Math.sin(yaw) * dy;
      message.position[Y] = base(Y) + Math.sin(yaw) * dx + Math.cos(yaw) * dy;
    }
    for (const axis of positionAxes.filter(isAngle)) {
      message.position[axis] = wrapAngle(message.position[axis]!);
    }
  }

  if (
    rows[YAW].mode === POSITION &&
    form.positionFrame !== "absolute" &&
    Math.abs(rows[YAW].position) > 180
  ) {
    warnings.push(
      "Turns take the short way round, so a relative yaw over 180° turns the other way",
    );
  }
  if (zPosition && !form.altitude && message.position[Z] > 0) {
    warnings.push("z is above the surface (depth is −z): the vehicle will surface");
  }
  if (zPosition && form.altitude && message.position[Z] <= 0) {
    warnings.push("Altitude is height above the bottom and should be positive");
  }
  const streams = rows.some((row) => row.mode === VELOCITY || row.mode === EFFORT);
  if (streams && form.timeout === 0) {
    warnings.push("Timeout 0 latches Velocity and Effort axes until another command replaces them");
  }
  return { message, warnings };
}
