// The sub_control_interfaces messages these panels publish and read. Keep in sync with
// thalassic/src/sub_control/sub_control_interfaces/msg/{MotionSetpoint,ControllerStatus}.msg.

export const MOTION_SETPOINT_SCHEMA = "sub_control_interfaces/msg/MotionSetpoint";
export const CONTROLLER_STATUS_SCHEMA = "sub_control_interfaces/msg/ControllerStatus";

// Defaults for the marlin_v3 namespace that sub_bringup launches into.
export const DEFAULT_SETPOINT_TOPIC = "/marlin_v3/motion_setpoint";
export const DEFAULT_STATUS_TOPIC = "/marlin_v3/control/status";
export const DEFAULT_ODOMETRY_TOPIC = "/marlin_v3/odometry/filtered";
export const DEFAULT_ALTITUDE_TOPIC = "/marlin_v3/altitude";
export const DEFAULT_RESET_SERVICE = "/marlin_v3/sub_control/reset_pose";

// Axis order of every 6-vector: [x, y, z, roll, pitch, yaw].
export const X = 0;
export const Y = 1;
export const Z = 2;
export const ROLL = 3;
export const PITCH = 4;
export const YAW = 5;
export const NUM_DOF = 6;
export const AXIS_NAMES = ["x", "y", "z", "roll", "pitch", "yaw"] as const;

// MotionSetpoint.mode
export const KEEP = 0;
export const POSITION = 1;
export const VELOCITY = 2;
export const HOLD = 3;
export const EFFORT = 4;
export type AxisMode =
  typeof KEEP | typeof POSITION | typeof VELOCITY | typeof HOLD | typeof EFFORT;
export const MODE_NAMES: Record<number, string> = {
  [KEEP]: "Keep",
  [POSITION]: "Position",
  [VELOCITY]: "Velocity",
  [HOLD]: "Hold",
  [EFFORT]: "Effort",
};

// MotionSetpoint.velocity_frame
export const HEADING = 0;
export const WORLD = 1;
export type VelocityFrame = typeof HEADING | typeof WORLD;

export type Six<T> = [T, T, T, T, T, T];

export type MotionSetpoint = {
  header: { stamp: { sec: number; nanosec: number }; frame_id: string };
  mode: Six<AxisMode>;
  position: Six<number>;
  velocity: Six<number>;
  effort: Six<number>;
  velocity_frame: VelocityFrame;
  altitude: boolean;
  timeout: number;
};

export function emptySetpoint(): MotionSetpoint {
  return {
    header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "" },
    mode: [KEEP, KEEP, KEEP, KEEP, KEEP, KEEP],
    position: [0, 0, 0, 0, 0, 0],
    velocity: [0, 0, 0, 0, 0, 0],
    effort: [0, 0, 0, 0, 0, 0],
    velocity_frame: HEADING,
    altitude: false,
    timeout: 0,
  };
}

/** Every axis comes to a smooth stop and holds where it stops. */
export function holdAllSetpoint(): MotionSetpoint {
  const msg = emptySetpoint();
  msg.mode = [HOLD, HOLD, HOLD, HOLD, HOLD, HOLD];
  return msg;
}

/** Roll and pitch go back to level; the other axes carry on. */
export function levelSetpoint(): MotionSetpoint {
  const msg = emptySetpoint();
  msg.mode[ROLL] = POSITION;
  msg.mode[PITCH] = POSITION;
  return msg;
}

// The fields of ControllerStatus the panels show. Numeric arrays arrive as typed arrays.
export type ControllerStatus = {
  mode: ArrayLike<number>;
  altitude: boolean;
  target: ArrayLike<number>;
  reference_position: ArrayLike<number>;
  reference_velocity: ArrayLike<number>;
  thruster_saturated: ArrayLike<boolean>;
  thruster_health: ArrayLike<number>;
  axis_controllable: ArrayLike<boolean>;
  killed: boolean;
  failsafe: boolean;
  dvl_ok: boolean;
  depth_ok: boolean;
  altitude_ok: boolean;
  state_age: number;
};

// ROS 2 message definitions for publishing through foxglove_bridge, which serializes to CDR in
// the app and needs the full definition tree (advertise's `datatypes` option).
type FieldDefinition = {
  type: string;
  name: string;
  isComplex?: boolean;
  isArray?: boolean;
  arrayLength?: number;
  isConstant?: boolean;
  value?: number;
  valueText?: string;
};
type MessageDefinition = { name?: string; definitions: FieldDefinition[] };

function constant(name: string, value: number): FieldDefinition {
  return { type: "uint8", name, isConstant: true, value, valueText: String(value) };
}

function float64x6(name: string): FieldDefinition {
  return { type: "float64", name, isArray: true, arrayLength: NUM_DOF };
}

export const MOTION_SETPOINT_DATATYPES = new Map<string, MessageDefinition>([
  [
    "builtin_interfaces/msg/Time",
    {
      name: "builtin_interfaces/msg/Time",
      definitions: [
        { type: "int32", name: "sec" },
        { type: "uint32", name: "nanosec" },
      ],
    },
  ],
  [
    "std_msgs/msg/Header",
    {
      name: "std_msgs/msg/Header",
      definitions: [
        { type: "builtin_interfaces/msg/Time", name: "stamp", isComplex: true },
        { type: "string", name: "frame_id" },
      ],
    },
  ],
  [
    MOTION_SETPOINT_SCHEMA,
    {
      name: MOTION_SETPOINT_SCHEMA,
      definitions: [
        { type: "std_msgs/msg/Header", name: "header", isComplex: true },
        constant("KEEP", KEEP),
        constant("POSITION", POSITION),
        constant("VELOCITY", VELOCITY),
        constant("HOLD", HOLD),
        constant("EFFORT", EFFORT),
        { type: "uint8", name: "mode", isArray: true, arrayLength: NUM_DOF },
        float64x6("position"),
        float64x6("velocity"),
        float64x6("effort"),
        constant("HEADING", HEADING),
        constant("WORLD", WORLD),
        { type: "uint8", name: "velocity_frame" },
        { type: "bool", name: "altitude" },
        { type: "float64", name: "timeout" },
      ],
    },
  ],
]);

type Vector3 = { x: number; y: number; z: number };

// The EKF's nav_msgs/Odometry: pose in odom, twist in the body frame.
export type Odometry = {
  pose: { pose: { position: Vector3; orientation: Vector3 & { w: number } } };
  twist: { twist: { linear: Vector3; angular: Vector3 } };
};

// sensor_msgs/Range from the DVL: altitude above the bottom.
export type Range = { range: number; min_range: number; max_range: number };

/** [x, y, z, roll, pitch, yaw] with ZYX Euler angles, as sub_control measures the pose. */
export function odometryPose(odometry: Odometry): Six<number> {
  const { position: p, orientation: q } = odometry.pose.pose;
  const roll = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x))));
  const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  return [p.x, p.y, p.z, roll, pitch, yaw];
}

/** A usable altitude, or undefined when the DVL has no bottom lock. */
export function rangeAltitude(range: Range): number | undefined {
  const { range: value, min_range: min, max_range: max } = range;
  return Number.isFinite(value) && value >= min && value <= max && value > 0 ? value : undefined;
}

export function isOdometrySchema(schemaName: string): boolean {
  return schemaName === "nav_msgs/msg/Odometry" || schemaName === "nav_msgs/Odometry";
}

export function isRangeSchema(schemaName: string): boolean {
  return schemaName === "sensor_msgs/msg/Range" || schemaName === "sensor_msgs/Range";
}

export function isMotionSetpointSchema(schemaName: string): boolean {
  return (
    schemaName === MOTION_SETPOINT_SCHEMA || schemaName === "sub_control_interfaces/MotionSetpoint"
  );
}

export function isControllerStatusSchema(schemaName: string): boolean {
  return (
    schemaName === CONTROLLER_STATUS_SCHEMA ||
    schemaName === "sub_control_interfaces/ControllerStatus"
  );
}

export const DEG = Math.PI / 180;

export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
