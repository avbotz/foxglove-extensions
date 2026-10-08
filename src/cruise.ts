// Velocity commands from the pilot panel's Command card. Rather than latch a velocity in the
// controller, the panel keeps streaming it with the stream timeout, so the vehicle holds on its
// own if the panel goes away. No React or Foxglove here, so it can be unit tested.

import {
  HOLD,
  KEEP,
  MotionSetpoint,
  NUM_DOF,
  POSITION,
  Six,
  VELOCITY,
  VelocityFrame,
  X,
  Y,
  emptySetpoint,
} from "./msgs";
import { Targets, hasTargets, noTargets, positionSetpoint } from "./targets";

/** Velocities the panel keeps sending [m/s, rad/s, odom signs]; x and y along `frame`. */
export type Cruise = {
  velocity: Targets;
  frame: VelocityFrame;
  /** Clock time [ms] to stop at; undefined runs until stopped. */
  until: number | undefined;
};

export function cruising(cruise: Cruise | undefined): cruise is Cruise {
  return cruise != undefined && hasTargets(cruise.velocity);
}

/** The cruise without `axes` (x and y go together), or undefined if nothing is left. */
export function withoutAxes(
  cruise: Cruise | undefined,
  axes: readonly number[],
): Cruise | undefined {
  if (!cruise) {
    return undefined;
  }
  const velocity = cruise.velocity.slice() as Targets;
  for (const axis of axes) {
    velocity[axis] = undefined;
    if (axis === X || axis === Y) {
      velocity[X] = velocity[Y] = undefined;
    }
  }
  const next = { ...cruise, velocity };
  return cruising(next) ? next : undefined;
}

/**
 * Adds the cruise to this cycle's message. Cruising axes that manual input is driving (or that
 * the message otherwise commands) drop out of the cruise; once the cruise runs out, its axes get
 * one HOLD.
 */
export function cruiseStep(
  message: MotionSetpoint | undefined,
  cruise: Cruise | undefined,
  now: number,
  timeout: number,
): { message: MotionSetpoint | undefined; cruise: Cruise | undefined } {
  if (!cruise) {
    return { message, cruise };
  }
  const taken = message ? [0, 1, 2, 3, 4, 5].filter((axis) => message.mode[axis] !== KEEP) : [];
  const remaining = withoutAxes(cruise, taken);
  if (!remaining) {
    return { message, cruise: undefined };
  }
  const expired = remaining.until != undefined && now >= remaining.until;
  const out = message ?? emptySetpoint();
  out.timeout = timeout;
  for (let axis = 0; axis < NUM_DOF; axis++) {
    const velocity = remaining.velocity[axis];
    if (velocity == undefined) {
      continue;
    }
    out.mode[axis] = expired ? HOLD : VELOCITY;
    out.velocity[axis] = expired ? 0 : velocity;
  }
  if (!expired && remaining.velocity[X] != undefined) {
    out.velocity_frame = remaining.frame;
  }
  return { message: out, cruise: expired ? undefined : remaining };
}

/**
 * The Command card's Go: POSITION on axes with a position target, and a new cruise on axes
 * with a velocity. x and y share a mode, so a velocity on one of them sets the other to 0.
 */
export function commandTargets(
  positions: Targets,
  velocities: Targets,
  base: Six<number> | undefined,
): { positions: MotionSetpoint | undefined; velocity: Targets } | { error: string } {
  if (!hasTargets(positions) && !hasTargets(velocities)) {
    return { error: "Nothing to send" };
  }
  const xyPosition = positions[X] != undefined || positions[Y] != undefined;
  const xyVelocity = velocities[X] != undefined || velocities[Y] != undefined;
  if (xyPosition && xyVelocity) {
    return { error: "x and y must both be position or both be velocity" };
  }
  let positionMessage: MotionSetpoint | undefined;
  if (hasTargets(positions)) {
    const built = positionSetpoint(positions, base);
    if ("error" in built) {
      return built;
    }
    positionMessage = built.message;
  }
  const velocity = noTargets();
  for (let axis = 0; axis < NUM_DOF; axis++) {
    const value = velocities[axis];
    if (value == undefined) {
      continue;
    }
    if (!Number.isFinite(value)) {
      return { error: "A velocity is not a number" };
    }
    velocity[axis] = value;
  }
  if (xyVelocity) {
    velocity[X] ??= 0;
    velocity[Y] ??= 0;
  }
  return { positions: positionMessage, velocity };
}

/** Axes a message moves to a position, which leave any cruise. */
export function positionAxes(message: MotionSetpoint): number[] {
  return [0, 1, 2, 3, 4, 5].filter((axis) => message.mode[axis] === POSITION);
}
