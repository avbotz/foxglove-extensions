// The 6-DOF Teleop panel's saved config and its settings editor.

import { Immutable, SettingsTreeFields, SettingsTreeNodes, Topic } from "@foxglove/extension";

import { numberOr, record, stringOr, topicItems } from "./common";
import {
  DEFAULT_ALTITUDE_TOPIC,
  DEFAULT_ODOMETRY_TOPIC,
  DEFAULT_RESET_SERVICE,
  DEFAULT_SETPOINT_TOPIC,
  DEFAULT_STATUS_TOPIC,
  DEG,
  HEADING,
  PITCH,
  ROLL,
  Six,
  WORLD,
  X,
  Y,
  YAW,
  Z,
} from "./msgs";
import {
  DEFAULT_GAMEPAD_MAPPING,
  DOFS,
  GAMEPAD_SOURCES,
  GamepadAxisMapping,
  ManualMode,
  TeleopSettings,
  isGamepadSource,
  isManualMode,
} from "./teleop";

export type TeleopConfig = {
  topic: string;
  statusTopic: string;
  odometryTopic: string;
  altitudeTopic: string;
  resetService: string;
  rate: number;
  timeout: number;
  command: "velocity" | "effort";
  velocityFrame: "heading" | "world";
  levelOnRelease: boolean;
  manual: Six<ManualMode>;
  /** What the Command card sends on each axis. x and y always share one. */
  commandModes: Six<CommandMode>;
  /** How long a Command card velocity runs [s]; 0 runs until stopped. */
  cruiseSeconds: number;
  cruiseFrame: "heading" | "world";
  /** Speeds a full key press or stick sends [m/s, m/s, deg/s, deg/s]. */
  maxSpeed: { horizontal: number; vertical: number; rollPitch: number; yaw: number };
  /** Full-deflection efforts [N, N*m]. */
  maxEffort: { force: number; torque: number };
  /** Position steps [m, m, deg, deg]. */
  steps: { horizontal: number; vertical: number; rollPitch: number; yaw: number };
  deadzone: number;
  gamepad: Six<GamepadAxisMapping>;
};

// Speeds well inside the trajectory limits in gains.yaml and gains_sim.yaml.
export const DEFAULT_TELEOP_CONFIG: TeleopConfig = {
  topic: DEFAULT_SETPOINT_TOPIC,
  statusTopic: DEFAULT_STATUS_TOPIC,
  odometryTopic: DEFAULT_ODOMETRY_TOPIC,
  altitudeTopic: DEFAULT_ALTITUDE_TOPIC,
  resetService: DEFAULT_RESET_SERVICE,
  rate: 10,
  timeout: 0.5,
  command: "velocity",
  velocityFrame: "heading",
  levelOnRelease: false,
  manual: ["rate", "rate", "rate", "rate", "rate", "rate"],
  commandModes: ["position", "position", "position", "position", "position", "position"],
  cruiseSeconds: 0,
  cruiseFrame: "heading",
  maxSpeed: { horizontal: 0.15, vertical: 0.1, rollPitch: 10, yaw: 15 },
  maxEffort: { force: 15, torque: 3 },
  steps: { horizontal: 0.25, vertical: 0.1, rollPitch: 5, yaw: 15 },
  deadzone: 0.12,
  gamepad: DEFAULT_GAMEPAD_MAPPING,
};

const LIMITS = {
  rate: [1, 50],
  timeout: [0.1, 5],
  horizontal: [0, 2],
  vertical: [0, 2],
  rollPitch: [0, 90],
  yaw: [0, 180],
  force: [0, 200],
  torque: [0, 50],
  cruiseSeconds: [0, 600],
  deadzone: [0, 0.9],
  horizontalStep: [0.01, 10],
  verticalStep: [0.01, 5],
  rollPitchStep: [0.5, 45],
  yawStep: [0.5, 180],
} as const;

export function limited(key: keyof typeof LIMITS, value: unknown, fallback: number): number {
  return numberOr(value, fallback, LIMITS[key][0], LIMITS[key][1]);
}

export type CommandMode = "position" | "velocity";

export function isCommandMode(value: unknown): value is CommandMode {
  return value === "position" || value === "velocity";
}

/** `modes` with `axis` set to `mode`, and its partner too for x and y. */
export function withAxisMode<T>(modes: Six<T>, axis: number, mode: T): Six<T> {
  const next = modes.slice() as Six<T>;
  for (const a of axis === X || axis === Y ? [X, Y] : [axis]) {
    next[a] = mode;
  }
  return next;
}

// Manual modes are set per group: x and y always share one.
export const MANUAL_GROUPS = [
  { key: "horizontal", label: "Surge/sway", axes: [X, Y] },
  { key: "heave", label: "Heave", axes: [Z] },
  { key: "roll", label: "Roll", axes: [ROLL] },
  { key: "pitch", label: "Pitch", axes: [PITCH] },
  { key: "yaw", label: "Yaw", axes: [YAW] },
] as const;

export function withManual(
  manual: Six<ManualMode>,
  axis: number,
  mode: ManualMode,
): Six<ManualMode> {
  return withAxisMode(manual, axis, mode);
}

export function loadTeleopConfig(saved: unknown): TeleopConfig {
  const s = record(saved);
  const speed = record(s.maxSpeed);
  const effort = record(s.maxEffort);
  const steps = record(s.steps);
  const pads: unknown[] = Array.isArray(s.gamepad) ? s.gamepad : [];
  const manual: unknown[] = Array.isArray(s.manual) ? s.manual : [];
  const commandModes: unknown[] = Array.isArray(s.commandModes) ? s.commandModes : [];
  const d = DEFAULT_TELEOP_CONFIG;
  const loadedCommandModes = d.commandModes.map((fallback, axis) => {
    const mode = commandModes[axis];
    return isCommandMode(mode) ? mode : fallback;
  }) as Six<CommandMode>;
  loadedCommandModes[Y] = loadedCommandModes[X];
  const loadedManual = d.manual.map((fallback, axis) => {
    const mode = manual[axis];
    return isManualMode(mode) ? mode : fallback;
  }) as Six<ManualMode>;
  loadedManual[Y] = loadedManual[X];
  return {
    topic: stringOr(s.topic, d.topic),
    statusTopic: stringOr(s.statusTopic, d.statusTopic),
    odometryTopic: stringOr(s.odometryTopic, d.odometryTopic),
    altitudeTopic: stringOr(s.altitudeTopic, d.altitudeTopic),
    resetService: stringOr(s.resetService, d.resetService),
    rate: limited("rate", s.rate, d.rate),
    timeout: limited("timeout", s.timeout, d.timeout),
    command: s.command === "effort" ? "effort" : "velocity",
    velocityFrame: s.velocityFrame === "world" ? "world" : "heading",
    levelOnRelease: typeof s.levelOnRelease === "boolean" ? s.levelOnRelease : d.levelOnRelease,
    manual: loadedManual,
    commandModes: loadedCommandModes,
    cruiseSeconds: limited("cruiseSeconds", s.cruiseSeconds, d.cruiseSeconds),
    cruiseFrame: s.cruiseFrame === "world" ? "world" : "heading",
    maxSpeed: {
      horizontal: limited("horizontal", speed.horizontal, d.maxSpeed.horizontal),
      vertical: limited("vertical", speed.vertical, d.maxSpeed.vertical),
      rollPitch: limited("rollPitch", speed.rollPitch, d.maxSpeed.rollPitch),
      yaw: limited("yaw", speed.yaw, d.maxSpeed.yaw),
    },
    maxEffort: {
      force: limited("force", effort.force, d.maxEffort.force),
      torque: limited("torque", effort.torque, d.maxEffort.torque),
    },
    steps: {
      horizontal: limited("horizontalStep", steps.horizontal, d.steps.horizontal),
      vertical: limited("verticalStep", steps.vertical, d.steps.vertical),
      rollPitch: limited("rollPitchStep", steps.rollPitch, d.steps.rollPitch),
      yaw: limited("yawStep", steps.yaw, d.steps.yaw),
    },
    deadzone: limited("deadzone", s.deadzone, d.deadzone),
    gamepad: DEFAULT_GAMEPAD_MAPPING.map((fallback, dof) => {
      const mapping = record(pads[dof]);
      return {
        source: isGamepadSource(mapping.source) ? mapping.source : fallback.source,
        invert: typeof mapping.invert === "boolean" ? mapping.invert : fallback.invert,
      };
    }) as Six<GamepadAxisMapping>,
  };
}

const TOPIC_FIELDS = [
  "topic",
  "statusTopic",
  "odometryTopic",
  "altitudeTopic",
  "resetService",
] as const;

export function applyTeleopSetting(
  config: TeleopConfig,
  path: readonly string[],
  value: unknown,
): TeleopConfig {
  const [node, field = ""] = path;
  const next = loadTeleopConfig(config);
  const topicField = TOPIC_FIELDS.find((name) => name === field);
  if (node === "general" && topicField != undefined) {
    next[topicField] = typeof value === "string" ? value.trim() : "";
  } else if (node === "general" && (field === "rate" || field === "timeout")) {
    next[field] = limited(field, value, next[field]);
  } else if (node === "general" && field === "command") {
    next.command = value === "effort" ? "effort" : "velocity";
  } else if (node === "general" && field === "velocityFrame") {
    next.velocityFrame = value === "world" ? "world" : "heading";
  } else if (node === "general" && field === "levelOnRelease") {
    next.levelOnRelease = value === true;
  } else if (node === "manual") {
    const group = MANUAL_GROUPS.find(({ key }) => key === field);
    if (group && isManualMode(value)) {
      next.manual = withManual(next.manual, group.axes[0], value);
    }
  } else if (node === "speed" && field in next.maxSpeed) {
    const key = field as keyof TeleopConfig["maxSpeed"];
    next.maxSpeed[key] = limited(key, value, next.maxSpeed[key]);
  } else if (node === "effort" && field in next.maxEffort) {
    const key = field as keyof TeleopConfig["maxEffort"];
    next.maxEffort[key] = limited(key, value, next.maxEffort[key]);
  } else if (node === "steps" && field in next.steps) {
    const key = field as keyof TeleopConfig["steps"];
    next.steps[key] = limited(`${key}Step`, value, next.steps[key]);
  } else if (node === "gamepad") {
    const match = /^(source|invert)(\d)$/.exec(field);
    const mapping = match ? next.gamepad[Number(match[2])] : undefined;
    if (field === "deadzone") {
      next.deadzone = limited("deadzone", value, next.deadzone);
    } else if (mapping && match?.[1] === "source" && isGamepadSource(value)) {
      mapping.source = value;
    } else if (mapping && match?.[1] === "invert") {
      mapping.invert = value === true;
    }
  }
  return next;
}

/** Long enough that a stream at this rate survives a dropped message or two. */
export function effectiveTimeout(config: TeleopConfig): number {
  return Math.max(config.timeout, 2.5 / config.rate);
}

export function teleopSettings(config: TeleopConfig): TeleopSettings {
  const { horizontal, vertical, rollPitch, yaw } = config.maxSpeed;
  const { force, torque } = config.maxEffort;
  return {
    manual: config.manual,
    command: config.command,
    maxVelocity: [horizontal, horizontal, vertical, rollPitch * DEG, rollPitch * DEG, yaw * DEG],
    maxEffort: [force, force, force, torque, torque, torque],
    velocityFrame: config.velocityFrame === "world" ? WORLD : HEADING,
    timeout: effectiveTimeout(config),
    levelOnRelease: config.levelOnRelease,
  };
}

/** Step sizes per axis [m, rad]. */
export function stepSizes(config: TeleopConfig): Six<number> {
  const { horizontal, vertical, rollPitch, yaw } = config.steps;
  return [horizontal, horizontal, vertical, rollPitch * DEG, rollPitch * DEG, yaw * DEG];
}

const MANUAL_OPTIONS = [
  { label: "Rate: velocity while held", value: "rate" },
  { label: "Step: one position step per press", value: "step" },
  { label: "Lock: ignore input", value: "lock" },
];

export function buildTeleopSettings(
  config: TeleopConfig,
  topics: Immutable<Topic[]>,
): SettingsTreeNodes {
  const raised = effectiveTimeout(config) > config.timeout;
  const sourceOptions = Object.entries(GAMEPAD_SOURCES).map(([value, { label }]) => ({
    label,
    value,
  }));
  const gamepadFields: SettingsTreeFields = {
    deadzone: {
      label: "Deadzone",
      input: "number",
      value: config.deadzone,
      step: 0.01,
      min: 0,
      max: 0.9,
      precision: 2,
    },
  };
  config.gamepad.forEach((mapping, dof) => {
    const { label, positive } = DOFS[dof]!;
    gamepadFields[`source${dof}`] = {
      label: `${label} (${positive} +)`,
      input: "select",
      value: mapping.source,
      options: sourceOptions,
    };
    gamepadFields[`invert${dof}`] = {
      label: `Invert ${label.toLowerCase()}`,
      input: "boolean",
      value: mapping.invert,
    };
  });
  const manualFields: SettingsTreeFields = {};
  for (const group of MANUAL_GROUPS) {
    manualFields[group.key] = {
      label: group.label,
      input: "select",
      value: config.manual[group.axes[0]],
      options: MANUAL_OPTIONS,
    };
  }
  const number = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    precision = 2,
  ) => ({ label, input: "number" as const, value, min, max, step, precision });

  return {
    general: {
      label: "Teleop",
      fields: {
        topic: {
          label: "Command topic",
          input: "autocomplete",
          value: config.topic,
          items: topicItems(topics, "setpoint", config.topic),
          help: "sub_control_interfaces/msg/MotionSetpoint",
          error: config.topic === "" ? "Set a topic to publish on" : undefined,
        },
        statusTopic: {
          label: "Status topic",
          input: "autocomplete",
          value: config.statusTopic,
          items: topicItems(topics, "status", config.statusTopic),
          help: "sub_control_interfaces/msg/ControllerStatus",
        },
        odometryTopic: {
          label: "Odometry topic",
          input: "autocomplete",
          value: config.odometryTopic,
          items: topicItems(topics, "odometry", config.odometryTopic),
          help: "nav_msgs/msg/Odometry: the measured pose on the instruments",
        },
        altitudeTopic: {
          label: "Altitude topic",
          input: "autocomplete",
          value: config.altitudeTopic,
          items: topicItems(topics, "altitude", config.altitudeTopic),
          help: "sensor_msgs/msg/Range from the DVL: the bottom on the depth gauge",
        },
        resetService: {
          label: "Re-zero service",
          input: "string",
          value: config.resetService,
          help: "std_srvs/srv/Trigger that makes the current position and heading the origin",
        },
        command: {
          label: "Rate command",
          input: "select",
          value: config.command,
          options: [
            { label: "Velocity (closed loop)", value: "velocity" },
            { label: "Effort (open loop)", value: "effort" },
          ],
          help: "Effort pushes with a force or torque and no feedback: for checking thruster directions and identification",
        },
        velocityFrame: {
          label: "Surge/sway frame",
          input: "select",
          value: config.velocityFrame,
          options: [
            { label: "Heading", value: "heading" },
            { label: "World (odom x/y)", value: "world" },
          ],
          help: "Heading: forward is along the vehicle's yaw. World: forward is odom +x and right is odom −y.",
        },
        levelOnRelease: {
          label: "Level roll/pitch on release",
          input: "boolean",
          value: config.levelOnRelease,
          help: "Released roll and pitch return to level instead of holding where they stopped",
        },
        rate: number("Publish rate (Hz)", config.rate, 1, 50, 1, 0),
        timeout: {
          ...number("Stream timeout (s)", config.timeout, 0.1, 5, 0.1),
          help: "The controller holds a driven axis if no command refreshes it for this long",
          warning: raised
            ? `Raised to ${effectiveTimeout(config).toFixed(2)} s to cover 2.5 publish periods`
            : undefined,
        },
      },
    },
    manual: { label: "Manual modes", fields: manualFields },
    steps: {
      label: "Step sizes",
      fields: {
        horizontal: number("Surge/sway (m)", config.steps.horizontal, 0.01, 10, 0.05),
        vertical: number("Heave (m)", config.steps.vertical, 0.01, 5, 0.05),
        rollPitch: number("Roll/pitch (°)", config.steps.rollPitch, 0.5, 45, 1, 1),
        yaw: number("Yaw (°)", config.steps.yaw, 0.5, 180, 1, 1),
      },
    },
    speed: {
      label: "Speeds sent (also in the panel)",
      fields: {
        horizontal: number("Surge/sway (m/s)", config.maxSpeed.horizontal, 0, 2, 0.05),
        vertical: number("Heave (m/s)", config.maxSpeed.vertical, 0, 2, 0.05),
        rollPitch: number("Roll/pitch (°/s)", config.maxSpeed.rollPitch, 0, 90, 1, 0),
        yaw: number("Yaw (°/s)", config.maxSpeed.yaw, 0, 180, 1, 0),
      },
    },
    effort: {
      label: "Full-deflection effort",
      defaultExpansionState: "collapsed",
      fields: {
        force: number("Force (N)", config.maxEffort.force, 0, 200, 1, 0),
        torque: number("Torque (N·m)", config.maxEffort.torque, 0, 50, 0.5, 1),
      },
    },
    gamepad: { label: "Gamepad", defaultExpansionState: "collapsed", fields: gamepadFields },
  };
}
