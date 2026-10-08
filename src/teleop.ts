// Teleop input handling and the MotionSetpoint each publishing cycle sends. No React or
// Foxglove here, so it can be unit tested.

import {
  AxisMode,
  EFFORT,
  HOLD,
  MotionSetpoint,
  NUM_DOF,
  PITCH,
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
} from "./msgs";

// Inputs are in the operator's directions: forward, right, up, roll right (starboard down),
// nose up and yaw right. The controller works in body FLU, where +y is left, +pitch is nose
// down and +yaw is counterclockwise from above, so those three flip on the way out.
export const OPERATOR_TO_FLU: Six<number> = [1, -1, 1, 1, -1, -1];

export const DOFS: Six<{ label: string; positive: string; negative: string }> = [
  { label: "Surge", positive: "forward", negative: "back" },
  { label: "Sway", positive: "right", negative: "left" },
  { label: "Heave", positive: "up", negative: "down" },
  { label: "Roll", positive: "right", negative: "left" },
  { label: "Pitch", positive: "nose up", negative: "nose down" },
  { label: "Yaw", positive: "right", negative: "left" },
];

export function zeros(): Six<number> {
  return [0, 0, 0, 0, 0, 0];
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

// --- Keyboard ---

export type KeyBinding = { code: string; label: string; dof: number; sign: 1 | -1 };

// Matched on KeyboardEvent.code, the physical key, so the layout holds on any keyboard.
// Translation and yaw under the left hand, as in the old 4-DOF panel; pitch and roll under
// the right, I pushing the nose down like a stick pushed forward.
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { code: "KeyW", label: "W", dof: X, sign: 1 },
  { code: "KeyS", label: "S", dof: X, sign: -1 },
  { code: "KeyA", label: "A", dof: Y, sign: -1 },
  { code: "KeyD", label: "D", dof: Y, sign: 1 },
  { code: "KeyR", label: "R", dof: Z, sign: 1 },
  { code: "KeyF", label: "F", dof: Z, sign: -1 },
  { code: "KeyQ", label: "Q", dof: YAW, sign: -1 },
  { code: "KeyE", label: "E", dof: YAW, sign: 1 },
  { code: "KeyI", label: "I", dof: PITCH, sign: -1 },
  { code: "KeyK", label: "K", dof: PITCH, sign: 1 },
  { code: "KeyJ", label: "J", dof: ROLL, sign: -1 },
  { code: "KeyL", label: "L", dof: ROLL, sign: 1 },
];
export const HOLD_KEY = "Space";
export const LEVEL_KEY = "KeyZ";

export function keyboardInput(pressed: ReadonlySet<string>): Six<number> {
  const input = zeros();
  for (const binding of KEY_BINDINGS) {
    if (pressed.has(binding.code)) {
      input[binding.dof] = (input[binding.dof] ?? 0) + binding.sign;
    }
  }
  return input;
}

// --- Gamepad (W3C standard mapping) ---

export type GamepadSnapshot = {
  axes: readonly number[];
  buttons: readonly { value: number }[];
};

const LB = 4;
const RB = 5;
const LT = 6;
const RT = 7;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
export const GAMEPAD_HOLD_BUTTON = 1; // B, circle
export const GAMEPAD_LEVEL_BUTTON = 3; // Y, triangle

function stick(pad: GamepadSnapshot, index: number): number {
  return pad.axes[index] ?? 0;
}

function button(pad: GamepadSnapshot, index: number): number {
  return pad.buttons[index]?.value ?? 0;
}

export function buttonPressed(pad: GamepadSnapshot, index: number): boolean {
  return button(pad, index) > 0.5;
}

// Each source reads positive toward the direction in its label.
export const GAMEPAD_SOURCES = {
  none: { label: "Unassigned", read: (_pad: GamepadSnapshot): number => 0 },
  leftX: { label: "Left stick, right +", read: (pad: GamepadSnapshot): number => stick(pad, 0) },
  leftY: { label: "Left stick, up +", read: (pad: GamepadSnapshot): number => -stick(pad, 1) },
  rightX: { label: "Right stick, right +", read: (pad: GamepadSnapshot): number => stick(pad, 2) },
  rightY: { label: "Right stick, up +", read: (pad: GamepadSnapshot): number => -stick(pad, 3) },
  triggers: {
    label: "Triggers, RT + / LT −",
    read: (pad: GamepadSnapshot): number => button(pad, RT) - button(pad, LT),
  },
  bumpers: {
    label: "Bumpers, RB + / LB −",
    read: (pad: GamepadSnapshot): number => button(pad, RB) - button(pad, LB),
  },
  dpadX: {
    label: "D-pad, right + / left −",
    read: (pad: GamepadSnapshot): number => button(pad, DPAD_RIGHT) - button(pad, DPAD_LEFT),
  },
  dpadY: {
    label: "D-pad, up + / down −",
    read: (pad: GamepadSnapshot): number => button(pad, DPAD_UP) - button(pad, DPAD_DOWN),
  },
};
export type GamepadSource = keyof typeof GAMEPAD_SOURCES;

export function isGamepadSource(value: unknown): value is GamepadSource {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GAMEPAD_SOURCES, value);
}

export type GamepadAxisMapping = { source: GamepadSource; invert: boolean };

// ArduSub's layout for the four main axes (left stick surge and yaw, right stick heave and
// sway), the analog triggers on pitch for aiming, and the bumpers on roll, which the
// self-righting hull rarely needs.
export const DEFAULT_GAMEPAD_MAPPING: Six<GamepadAxisMapping> = [
  { source: "leftY", invert: false },
  { source: "rightX", invert: false },
  { source: "rightY", invert: false },
  { source: "bumpers", invert: false },
  { source: "triggers", invert: false },
  { source: "leftX", invert: false },
];

/** Zero inside the deadzone, rescaled outside it so the output still spans [-1, 1]. */
export function applyDeadzone(value: number, deadzone: number): number {
  const magnitude = Math.abs(value);
  if (!(magnitude > deadzone)) {
    return 0;
  }
  return Math.sign(value) * Math.min(1, (magnitude - deadzone) / (1 - deadzone));
}

export function gamepadInput(
  pad: GamepadSnapshot,
  mapping: readonly GamepadAxisMapping[],
  deadzone: number,
): Six<number> {
  const input = zeros();
  mapping.forEach(({ source, invert }, dof) => {
    const value = applyDeadzone(GAMEPAD_SOURCES[source].read(pad), deadzone);
    input[dof] = invert ? -value : value;
  });
  return input;
}

// --- Commands ---

/**
 * How manual input drives an axis:
 * - rate: stream a velocity while held, hold when let go
 * - step: each press moves the axis's position target by one step
 * - lock: ignore input; the axis keeps doing what it was told
 * x and y always share one.
 */
export type ManualMode = "rate" | "step" | "lock";

export function isManualMode(value: unknown): value is ManualMode {
  return value === "rate" || value === "step" || value === "lock";
}

export type TeleopSettings = {
  manual: Six<ManualMode>;
  command: "velocity" | "effort";
  /** Full-deflection speed per axis, magnitudes [m/s, rad/s]. */
  maxVelocity: Six<number>;
  /** Full-deflection effort per axis, magnitudes [N, N*m]. */
  maxEffort: Six<number>;
  velocityFrame: VelocityFrame;
  /** [s] the controller keeps a streamed axis going without a fresh message. */
  timeout: number;
  /** Released roll and pitch go back to level instead of holding where they are. */
  levelOnRelease: boolean;
};

export type TeleopStep = {
  /** What to publish this cycle; undefined when the panel has nothing to say. */
  message: MotionSetpoint | undefined;
  /** Axes this cycle drove; pass back in on the next one. */
  streaming: Six<boolean>;
};

/**
 * One publishing cycle. `input` is in operator directions, each in [-1, 1] after the speed
 * scale. `streaming` is what the previous cycle drove.
 *
 * A driven axis streams VELOCITY (or EFFORT), resent every cycle so that the controller's
 * timeout stops it if the panel goes quiet. A released axis gets one HOLD: a smooth stop,
 * holding where it stops. An axis nobody touches is left alone (KEEP), so an idle panel
 * never overrides a mission or the Motion Setpoint panel.
 */
export function teleopStep(
  input: readonly number[],
  streaming: readonly boolean[],
  settings: TeleopSettings,
): TeleopStep {
  const driven = input.map(
    (value, axis) => settings.manual[axis] === "rate" && value !== 0 && Number.isFinite(value),
  ) as Six<boolean>;
  // sub_control rejects a command whose x and y modes differ.
  driven[X] = driven[Y] = driven[X] || driven[Y];

  const message = emptySetpoint();
  message.velocity_frame = settings.velocityFrame;
  message.timeout = settings.timeout;
  let changed = false;
  for (let axis = 0; axis < NUM_DOF; axis++) {
    let mode: AxisMode | undefined;
    if (driven[axis] === true) {
      const raw = input[axis] ?? 0;
      const value = OPERATOR_TO_FLU[axis]! * clampUnit(Number.isFinite(raw) ? raw : 0);
      if (settings.command === "effort") {
        mode = EFFORT;
        message.effort[axis] = value * settings.maxEffort[axis]! + 0;
      } else {
        mode = VELOCITY;
        message.velocity[axis] = value * settings.maxVelocity[axis]! + 0;
      }
    } else if (streaming[axis] === true) {
      mode = settings.levelOnRelease && (axis === ROLL || axis === PITCH) ? POSITION : HOLD;
    }
    if (mode != undefined) {
      message.mode[axis] = mode;
      changed = true;
    }
  }
  return { message: changed ? message : undefined, streaming: driven };
}

/** The cycle that lets go of everything the last one drove. */
export function releaseStep(streaming: readonly boolean[], settings: TeleopSettings): TeleopStep {
  return teleopStep(zeros(), streaming, settings);
}

export const NOT_STREAMING: Six<boolean> = [false, false, false, false, false, false];

// An analog input steps once when it passes PRESS and again only after falling below RELEASE.
const STEP_PRESS = 0.6;
const STEP_RELEASE = 0.3;

/** Turns analog input on step-mode axes into whole steps, in operator directions. */
export function stepEdges(
  input: readonly number[],
  armed: readonly boolean[],
  manual: readonly ManualMode[],
): { counts: Six<number>; armed: Six<boolean> } {
  const counts = zeros();
  const nextArmed = armed.slice() as Six<boolean>;
  for (let axis = 0; axis < NUM_DOF; axis++) {
    const value = input[axis] ?? 0;
    if (manual[axis] !== "step" || Math.abs(value) < STEP_RELEASE) {
      nextArmed[axis] = true;
    } else if (Math.abs(value) >= STEP_PRESS && nextArmed[axis] === true) {
      counts[axis] = Math.sign(value);
      nextArmed[axis] = false;
    }
  }
  return { counts, armed: nextArmed };
}
