// Position and attitude targets for the pilot panel: steps from the current target, and the
// pending targets the operator sets on the instruments before sending them. No React or
// Foxglove here, so it can be unit tested.

import {
  DEG,
  MotionSetpoint,
  NUM_DOF,
  POSITION,
  Six,
  X,
  Y,
  YAW,
  Z,
  emptySetpoint,
  wrapAngle,
} from "./msgs";
import { OPERATOR_TO_FLU } from "./teleop";

/** Absolute odom targets per axis [m, rad]; undefined leaves the axis alone. */
export type Targets = Six<number | undefined>;

export function noTargets(): Targets {
  return [undefined, undefined, undefined, undefined, undefined, undefined];
}

export function hasTargets(targets: Targets): boolean {
  return targets.some((value) => value != undefined);
}

// The pilot panel shows z as depth (down +) and pitch as nose up +, the way an operator reads
// them; x, y, roll (right +) and yaw (counterclockwise +) are as in odom.
export const PILOT_SIGN: Six<number> = [1, 1, -1, 1, -1, 1];
export const PILOT_LABELS: Six<{ name: string; unit: string; hint: string }> = [
  { name: "x", unit: "m", hint: "odom" },
  { name: "y", unit: "m", hint: "odom" },
  { name: "Depth", unit: "m", hint: "down +" },
  { name: "Roll", unit: "°", hint: "right +" },
  { name: "Pitch", unit: "°", hint: "nose up +" },
  { name: "Yaw", unit: "°", hint: "left +" },
];

function displayScale(axis: number): number {
  return axis >= 3 ? DEG : 1;
}

/** An odom value [m, rad] in the pilot's units and signs [m, deg]. */
export function toPilot(axis: number, value: number): number {
  return (PILOT_SIGN[axis]! * value) / displayScale(axis) + 0;
}

/** The inverse of toPilot. */
export function fromPilot(axis: number, value: number): number {
  return PILOT_SIGN[axis]! * value * displayScale(axis) + 0;
}

/**
 * Targets one step from `base` on every axis with a nonzero count. Counts are in operator
 * directions (forward, right, up, roll right, nose up, yaw right); x and y steps run along the
 * heading of `base`, and move both together.
 */
export function stepTargets(
  counts: readonly number[],
  base: Six<number>,
  sizes: Six<number>,
): Targets {
  const targets = noTargets();
  const delta = counts.map((count, axis) => OPERATOR_TO_FLU[axis]! * count * sizes[axis]!);
  const [dx, dy] = [delta[X] ?? 0, delta[Y] ?? 0];
  if (dx !== 0 || dy !== 0) {
    const yaw = base[YAW];
    targets[X] = base[X] + Math.cos(yaw) * dx - Math.sin(yaw) * dy;
    targets[Y] = base[Y] + Math.sin(yaw) * dx + Math.cos(yaw) * dy;
  }
  for (let axis = Z; axis < NUM_DOF; axis++) {
    const step = delta[axis] ?? 0;
    if (step !== 0) {
      targets[axis] = base[axis]! + step;
    }
  }
  return targets;
}

/**
 * POSITION on every axis with a target. sub_control moves x and y together, so a target on
 * only one of them keeps the other where `base` has it.
 */
export function positionSetpoint(
  targets: Targets,
  base: Six<number> | undefined,
): { message: MotionSetpoint } | { error: string } {
  if (!hasTargets(targets)) {
    return { error: "No target set" };
  }
  const values = targets.slice() as Targets;
  if ((values[X] == undefined) !== (values[Y] == undefined)) {
    if (base == undefined) {
      return { error: "Moving x or y alone needs the current position, and there is none" };
    }
    values[X] ??= base[X];
    values[Y] ??= base[Y];
  }
  const message = emptySetpoint();
  for (let axis = 0; axis < NUM_DOF; axis++) {
    const value = values[axis];
    if (value == undefined) {
      continue;
    }
    if (!Number.isFinite(value)) {
      return { error: "A target is not a number" };
    }
    message.mode[axis] = POSITION;
    message.position[axis] = axis >= 3 ? wrapAngle(value) : value;
  }
  return { message };
}
