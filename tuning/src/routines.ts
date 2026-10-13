// Tuning routines: timed sequences of MotionSetpoint targets for sub_control, and the runner's
// decisions. No React or Foxglove here, so it can be unit tested.
//
// sub_control shapes every target into a jerk-limited trajectory within its trajectory.* limits,
// so a routine only says where to go (or how fast) and for how long. It is planned up front,
// relative to the pose it starts from, as segments the panel sends one after another. Positions
// are odom ENU (z up, so deeper is more negative) and rotations ZYX Euler angles, as in
// MotionSetpoint.

import {
  AXIS_NAMES,
  ControllerStatus,
  HOLD,
  KEEP,
  MotionSetpoint,
  NUM_DOF,
  Odometry,
  PITCH,
  POSITION,
  ROLL,
  Six,
  VELOCITY,
  WORLD,
  X,
  Y,
  Z,
  emptySetpoint,
  newCommandId,
} from "../../common/msgs";

export const ROUTINES = ["step", "cruise", "hold", "square"] as const;
export type RoutineKind = (typeof ROUTINES)[number];
export type AxisName = (typeof AXIS_NAMES)[number];

// Largest step [m, rad] and cruise speed [m/s, rad/s] a routine may ask for. Roll and pitch only
// step: a roll or pitch rate held for seconds would turn the vehicle over.
export const MAX_STEP: Six<number> = [3, 3, 1.5, 0.5, 0.5, Math.PI / 2];
export const MAX_SPEED: Six<number> = [1, 1, 0.5, 0, 0, 1];
// [m] routines that move z keep it at least this deep.
export const MIN_DEPTH = 0.3;
// [s] the timeout streamed VELOCITY targets carry: if the panel stops sending them, sub_control
// brings those axes to a HOLD this soon.
export const STREAM_TIMEOUT = 0.5;
// [ms] odometry and control/status older than this stop a routine.
export const TELEMETRY_TIMEOUT_MS = 1000;
export const ROUTINE_RATE = 20;

export const ROUTINE_AXES: Record<RoutineKind, readonly AxisName[]> = {
  step: AXIS_NAMES,
  cruise: ["x", "y", "z", "yaw"],
  hold: [],
  square: [],
};

export const ROUTINE_HINTS: Record<RoutineKind, string> = {
  step: "POSITION steps out, back, the other way and back, holding each.",
  cruise: "VELOCITY one way, stop and hold, then the other way.",
  hold: "Holds every axis where it is. Push the vehicle and watch it return.",
  square: "POSITION through the corners of a square in odom x/y: forward, then left.",
};

/** Amplitudes [m, rad, m/s, rad/s] and times [s] to start from. */
export const ROUTINE_DEFAULTS = {
  step: { x: 1, y: 1, z: 0.5, roll: 0.2, pitch: 0.2, yaw: 0.8, hold: 10, settle: 5, cycles: 1 },
  cruise: { x: 0.2, y: 0.2, z: 0.1, roll: 0, pitch: 0, yaw: 0.3, hold: 8, settle: 6, cycles: 1 },
  hold: { hold: 30, settle: 5, cycles: 1 },
  square: { amplitude: 1, hold: 12, settle: 5, cycles: 1 },
} as const;

export const TRAJECTORY_GROUP: Record<AxisName, string> = {
  x: "horizontal",
  y: "horizontal",
  z: "vertical",
  roll: "roll",
  pitch: "pitch",
  yaw: "yaw",
};

export type RoutineForm = {
  kind: RoutineKind;
  axis: AxisName;
  amplitude: number;
  hold: number;
  settle: number;
  cycles: number;
};

/** One MotionSetpoint, held for `duration` seconds. */
export type Segment = {
  duration: number;
  label: string;
  mode: Six<number>;
  position: Six<number>;
  velocity: Six<number>;
};

export type Routine = {
  kind: RoutineKind;
  axis: string;
  /** [x, y, z, roll, pitch, yaw] it starts from. */
  start: Six<number>;
  segments: Segment[];
  cycles: number;
  duration: number;
};

export function isRoutineKind(value: unknown): value is RoutineKind {
  return typeof value === "string" && (ROUTINES as readonly string[]).includes(value);
}

export function isAxisName(value: unknown): value is AxisName {
  return typeof value === "string" && (AXIS_NAMES as readonly string[]).includes(value);
}

/** VELOCITY targets time out, so they are sent again until the segment ends. */
export function streamed(segment: Segment): boolean {
  return segment.mode.includes(VELOCITY);
}

/** Index of the segment running `elapsed` seconds in, or undefined once the routine is over. */
export function segmentAt(routine: Routine, elapsed: number): number | undefined {
  let end = 0;
  for (const [index, segment] of routine.segments.entries()) {
    end += segment.duration;
    if (elapsed < end) {
      return index;
    }
  }
  return undefined;
}

/** The [x, y, z] points one cycle moves through, for the path view; empty if it does not translate. */
export function preview(routine: Routine): [number, number, number][] {
  const points: [number, number, number][] = [[routine.start[X], routine.start[Y], routine.start[Z]]];
  for (const segment of routine.segments.slice(0, routine.segments.length / routine.cycles)) {
    const last = points[points.length - 1]!;
    const point = [X, Y, Z].map((axis) =>
      segment.mode[axis] === POSITION ? segment.position[axis]! : last[axis]!,
    ) as [number, number, number];
    if (point.some((value, axis) => value !== last[axis])) {
      points.push(point);
    }
  }
  return points.length > 1 ? points : [];
}

const zeros = (): Six<number> => [0, 0, 0, 0, 0, 0];

// x and y always share a mode: an axis the routine does not set follows its partner, with its
// position at the start and its velocity at zero.
function withXyPair(mode: Six<number>): Six<number> {
  if (mode[X] === KEEP) {
    mode[X] = mode[Y];
  }
  if (mode[Y] === KEEP) {
    mode[Y] = mode[X];
  }
  return mode;
}

/** Every axis holds `pose`. */
export function holdAt(pose: Six<number>, duration = 0, label = "hold"): Segment {
  return {
    duration,
    label,
    mode: [POSITION, POSITION, POSITION, POSITION, POSITION, POSITION],
    position: [...pose] as Six<number>,
    velocity: zeros(),
  };
}

function move(start: Six<number>, offsets: Partial<Record<number, number>>, duration: number, label: string): Segment {
  const mode = [KEEP, KEEP, KEEP, KEEP, KEEP, KEEP] as Six<number>;
  const position = [...start] as Six<number>;
  for (const [axis, offset] of Object.entries(offsets)) {
    mode[Number(axis)] = POSITION;
    position[Number(axis)] = start[Number(axis)]! + (offset ?? 0);
  }
  return { duration, label, mode: withXyPair(mode), position, velocity: zeros() };
}

function cruise(axis: number, speed: number, duration: number, label: string): Segment {
  const mode = [KEEP, KEEP, KEEP, KEEP, KEEP, KEEP] as Six<number>;
  const velocity = zeros();
  mode[axis] = VELOCITY;
  velocity[axis] = speed;
  return { duration, label, mode: withXyPair(mode), position: zeros(), velocity };
}

function stop(axis: number, duration: number): Segment {
  const mode = [KEEP, KEEP, KEEP, KEEP, KEEP, KEEP] as Six<number>;
  mode[axis] = HOLD;
  return { duration, label: "stop and hold", mode: withXyPair(mode), position: zeros(), velocity: zeros() };
}

function sign(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Plans a routine from `start`, the pose sub_control is holding:
 * - step: POSITION start + amplitude, start, start - amplitude, start on one axis, `hold` s each
 * - cruise: VELOCITY +amplitude for `hold` s, HOLD for `settle`, then the other way (x, y, z, yaw)
 * - hold: POSITION at start on every axis for `hold` s; push the vehicle and watch it come back
 * - square: POSITION through the corners of a square of side `amplitude` in odom x/y (forward,
 *   then left), `hold` s at each
 */
export function plan(form: RoutineForm, start: Six<number>): Routine | { error: string } {
  const { kind, axis, amplitude, hold, settle, cycles } = form;
  if (!start.every(Number.isFinite)) {
    return { error: "The start pose must be six finite values" };
  }
  if (![amplitude, hold, settle].every(Number.isFinite) || !Number.isInteger(cycles)) {
    return { error: "Routine values must be numbers, and cycles a whole number" };
  }
  const routine = (axisName: string, segments: Segment[], count = 1): Routine => ({
    kind,
    axis: axisName,
    start,
    segments,
    cycles: count,
    duration: segments.reduce((sum, segment) => sum + segment.duration, 0),
  });
  const depthCheck = (highestZ: number) =>
    highestZ > -MIN_DEPTH
      ? `z would come within ${MIN_DEPTH} m of the surface; start deeper or move less`
      : undefined;

  if (kind === "hold") {
    if (!(hold >= 1 && hold <= 300)) {
      return { error: "A hold lasts 1 to 300 s" };
    }
    return routine(axis, [holdAt(start, hold)]);
  }
  if (!(cycles >= 1 && cycles <= 20)) {
    return { error: "Cycles must be 1 to 20" };
  }
  if (!(hold >= 0.5 && hold <= 120)) {
    return { error: "Hold time must be 0.5 to 120 s" };
  }

  if (kind === "square") {
    if (amplitude === 0 || Math.abs(amplitude) > MAX_STEP[X]) {
      return { error: `The square's side must be non-zero and at most ${MAX_STEP[X]} m` };
    }
    const corners: [number, number][] = [
      [amplitude, 0],
      [amplitude, amplitude],
      [0, amplitude],
      [0, 0],
    ];
    const segments: Segment[] = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      corners.forEach(([dx, dy], corner) => {
        segments.push(move(start, { [X]: dx, [Y]: dy }, hold, `corner ${corner + 1}`));
      });
    }
    return routine("xy", segments, cycles);
  }

  const index = AXIS_NAMES.indexOf(axis);
  const unit = index >= ROLL ? "rad" : "m";
  const maxStep = MAX_STEP[index]!;
  const maxSpeed = MAX_SPEED[index]!;

  if (kind === "step") {
    if (amplitude === 0 || Math.abs(amplitude) > maxStep) {
      return { error: `${axis} steps must be non-zero and at most ${maxStep} ${unit}` };
    }
    const tooShallow = index === Z ? depthCheck(start[Z] + Math.abs(amplitude)) : undefined;
    if (tooShallow != undefined) {
      return { error: tooShallow };
    }
    const segments: Segment[] = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const offset of [amplitude, 0, -amplitude, 0]) {
        segments.push(
          move(start, { [index]: offset }, hold, offset === 0 ? "start" : `${axis} ${sign(offset)} ${unit}`),
        );
      }
    }
    return routine(axis, segments, cycles);
  }

  // cruise
  if (maxSpeed === 0) {
    return { error: `${axis} does not cruise; step it instead` };
  }
  if (amplitude === 0 || Math.abs(amplitude) > maxSpeed) {
    return { error: `${axis} cruise must be non-zero and at most ${maxSpeed} ${unit}/s` };
  }
  if (!(settle >= 0.5 && settle <= 60)) {
    return { error: "Settle time must be 0.5 to 60 s" };
  }
  const tooShallow = index === Z ? depthCheck(start[Z] + Math.abs(amplitude) * hold) : undefined;
  if (tooShallow != undefined) {
    return { error: tooShallow };
  }
  const segments: Segment[] = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const speed of [amplitude, -amplitude]) {
      segments.push(cruise(index, speed, hold, `${axis} ${sign(speed)} ${unit}/s`), stop(index, settle));
    }
  }
  return routine(axis, segments, cycles);
}

/** Rough duration [s] of a rest-to-rest move of `distance` within [v max, a max, j max]. */
export function moveTime(distance: number, limits: readonly number[]): number {
  const [velocity = 0, acceleration = 0, jerk = 0] = limits;
  const d = Math.abs(distance);
  const cruiseTime =
    d > (velocity * velocity) / acceleration
      ? d / velocity + velocity / acceleration
      : 2 * Math.sqrt(d / acceleration);
  return cruiseTime + acceleration / jerk;
}

/** The segment as a MotionSetpoint. Routines work in odom axes, like the telemetry they are judged by. */
export function segmentSetpoint(segment: Segment, timeout: number, id: number): MotionSetpoint {
  const message = emptySetpoint();
  message.mode = [...segment.mode] as MotionSetpoint["mode"];
  message.position = [...segment.position] as Six<number>;
  message.velocity = [...segment.velocity] as Six<number>;
  message.velocity_frame = WORLD;
  message.timeout = timeout;
  message.id = id;
  return message;
}

/** Every axis comes to a smooth stop and holds there, with roll and pitch at the given angles. */
export function stopSetpoint(roll = 0, pitch = 0, id = 0): MotionSetpoint {
  const message = emptySetpoint();
  message.mode = [HOLD, HOLD, HOLD, POSITION, POSITION, HOLD];
  message.position[ROLL] = roll;
  message.position[PITCH] = pitch;
  message.id = id;
  return message;
}

/** Why a routine cannot run now, or undefined. `status` and `odometry` are passed only while fresh. */
export function problem(
  status: ControllerStatus | undefined,
  odometry: Odometry | undefined,
): string | undefined {
  if (status == undefined || odometry == undefined) {
    return "No live odometry/filtered and control/status";
  }
  if (status.killed) {
    return "Killed";
  }
  if (!status.armed) {
    return "sub_control is not armed (its log says what it is waiting for)";
  }
  if (status.failsafe) {
    return "sub_control is in failsafe (no state estimate or no IMU)";
  }
  return undefined;
}

/** Where sub_control is holding: each POSITION axis's target, else the measured pose. */
export function startPose(status: ControllerStatus, measured: Six<number>): Six<number> {
  const pose = [...measured] as Six<number>;
  for (let axis = 0; axis < NUM_DOF; axis++) {
    // A z target in altitude coordinates is not an odom z.
    if (status.mode[axis] === POSITION && !(axis === Z && status.altitude)) {
      pose[axis] = status.target[axis] ?? pose[axis]!;
    }
  }
  return pose;
}

/** A routine in progress. `tick` keeps `segment`, `ids` and `acknowledged` up to date. */
export type Run = {
  routine: Routine;
  /** [ms] clock time it started. */
  startedAt: number;
  segment: number | undefined;
  /** Command ids this run sent, to tell its commands from anyone else's. */
  ids: Set<number>;
  /** Whether sub_control has acknowledged one of this run's commands yet. */
  acknowledged: boolean;
};

export type TickAction =
  | { kind: "send"; message: MotionSetpoint; segment: number; label: string }
  | { kind: "finish"; status: "complete" | "aborted"; message: string; hold: boolean }
  | { kind: "none" };

export function newRun(routine: Routine, startedAt: number): Run {
  return { routine, startedAt, segment: undefined, ids: new Set(), acknowledged: false };
}

/**
 * What the runner does this cycle: sends the segment due (streamed ones every cycle), finishes
 * when the routine is over, or aborts when the vehicle is no longer fit to run it or another
 * command source has taken over (sub_control acknowledged a command id this run did not send).
 */
export function tick(
  run: Run,
  now: number,
  status: ControllerStatus | undefined,
  odometry: Odometry | undefined,
): TickAction {
  const issue = problem(status, odometry);
  if (issue != undefined) {
    return { kind: "finish", status: "aborted", message: issue, hold: status?.killed !== true };
  }
  const acknowledgedId = Number(status!.command_id);
  if (run.ids.has(acknowledgedId)) {
    run.acknowledged = true;
  } else if (run.acknowledged) {
    return {
      kind: "finish",
      status: "aborted",
      message: `Another command source took over (command id ${acknowledgedId})`,
      hold: true,
    };
  }
  const elapsed = (now - run.startedAt) / 1000;
  const index = segmentAt(run.routine, elapsed);
  if (index == undefined) {
    // The last segment already holds the start (or stops a cruise).
    return { kind: "finish", status: "complete", message: "Complete", hold: false };
  }
  const segment = run.routine.segments[index]!;
  if (index === run.segment && !streamed(segment)) {
    return { kind: "none" };
  }
  run.segment = index;
  const id = newCommandId();
  run.ids.add(id);
  return {
    kind: "send",
    message: segmentSetpoint(segment, streamed(segment) ? STREAM_TIMEOUT : 0, id),
    segment: index,
    label: `${index + 1}/${run.routine.segments.length}: ${segment.label}`,
  };
}
