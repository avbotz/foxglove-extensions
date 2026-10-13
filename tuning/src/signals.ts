// The Signals panel's data: every signal of the controller, in the frames of ControllerStatus so
// that target, reference and measurement compare directly (translation in odom ENU, rotation as
// ZYX Euler angles and their rates; wrench, integral and disturbance stay body FLU), and the
// buffer the graph draws from. No React or Foxglove here, so it can be unit tested.

import {
  AXIS_NAMES,
  ControllerStatus,
  NUM_THRUSTERS,
  Odometry,
  Six,
  Z,
  odometryPose,
  wrapAngle,
} from "../../common/msgs";

type Vector3 = { x: number; y: number; z: number };
type Quaternion = Vector3 & { w: number };

/** `v` rotated by `q` (body to odom). */
export function rotate(q: Quaternion, v: Vector3): [number, number, number] {
  // v + 2 w (u x v) + 2 u x (u x v), with u the quaternion's vector part.
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return [
    v.x + q.w * tx + q.y * tz - q.z * ty,
    v.y + q.w * ty + q.z * tx - q.x * tz,
    v.z + q.w * tz + q.x * ty - q.y * tx,
  ];
}

/** ZYX Euler angle rates from the body angular velocity [p, q, r]. */
export function eulerRates(roll: number, pitch: number, body: Vector3): [number, number, number] {
  const { x: p, y: q, z: r } = body;
  const cosPitch = Math.cos(pitch);
  const safeCos = (cosPitch < 0 ? -1 : 1) * Math.max(Math.abs(cosPitch), 1e-6);
  const lateral = q * Math.sin(roll) + r * Math.cos(roll);
  return [p + lateral * Math.tan(pitch), q * Math.cos(roll) - r * Math.sin(roll), lateral / safeCos];
}

export type Measured = { pose: Six<number>; velocity: Six<number> };

/**
 * The measured pose and its rates in the frames of the controller's reference. z is the DVL
 * altitude while the controller holds altitude, since the reference is in altitude coordinates.
 */
export function measuredState(
  odometry: Odometry,
  status: ControllerStatus | undefined,
  altitude: number | undefined,
): Measured {
  const pose = odometryPose(odometry);
  const q = odometry.pose.pose.orientation;
  const { linear, angular } = odometry.twist.twist;
  const velocity = [...rotate(q, linear), ...eulerRates(pose[3], pose[4], angular)] as Six<number>;
  if (status?.altitude === true && altitude != undefined) {
    pose[Z] = altitude;
  }
  return { pose, velocity };
}

/** Every signal with a finite value, from the latest status and measurement. */
export function signalsOf(
  status: ControllerStatus | undefined,
  measured: Measured | undefined,
  altitude: number | undefined,
): Record<string, number> {
  const signals: Record<string, number> = {};
  AXIS_NAMES.forEach((axis, index) => {
    if (measured) {
      signals[`${axis}.measured`] = measured.pose[index]!;
      signals[`${axis}.velocity`] = measured.velocity[index]!;
    }
    if (status) {
      signals[`${axis}.target`] = status.target[index]!;
      signals[`${axis}.reference`] = status.reference_position[index]!;
      signals[`${axis}.reference_velocity`] = status.reference_velocity[index]!;
      signals[`${axis}.reference_acceleration`] = status.reference_acceleration[index]!;
      signals[`${axis}.wrench_command`] = status.wrench_command[index]!;
      signals[`${axis}.wrench_achieved`] = status.wrench_achieved[index]!;
      signals[`${axis}.integral`] = status.integral[index]!;
      signals[`${axis}.disturbance`] = status.disturbance[index]!;
      if (measured) {
        const error = status.reference_position[index]! - measured.pose[index]!;
        signals[`${axis}.tracking_error`] = index > Z ? wrapAngle(error) : error;
      }
    }
  });
  if (status) {
    for (let thruster = 0; thruster < NUM_THRUSTERS; thruster++) {
      signals[`thruster_${thruster}.command`] = status.thruster_command[thruster]!;
      signals[`thruster_${thruster}.force`] = status.thruster_force[thruster]!;
    }
    signals.state_age = Math.min(status.state_age, 1e3);
  }
  if (altitude != undefined) {
    signals.altitude = altitude;
  }
  for (const [name, value] of Object.entries(signals)) {
    if (!Number.isFinite(value)) {
      delete signals[name];
    }
  }
  return signals;
}

export const VIEWS = {
  pose: { label: "Target / reference / measured", suffixes: ["target", "reference", "measured"] },
  tracking: { label: "Tracking error", suffixes: ["tracking_error"] },
  velocity: { label: "Reference / measured velocity", suffixes: ["reference_velocity", "velocity"] },
  wrench: { label: "Wrench / disturbance", suffixes: ["wrench_command", "wrench_achieved", "disturbance"] },
  integral: { label: "Integral", suffixes: ["integral"] },
  custom: { label: "Custom", suffixes: [] },
} as const;
export type ViewKey = keyof typeof VIEWS;

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VIEWS, value);
}

/** The signals a view shows for an axis; a custom view's come from `custom`. */
export function viewSignals(view: ViewKey, axis: string, custom: readonly string[]): string[] {
  return view === "custom"
    ? [...custom]
    : VIEWS[view].suffixes.map((suffix) => `${axis}.${suffix}`);
}

/** Every signal name there is, for picking. */
export const SIGNAL_NAMES: readonly string[] = [
  ...AXIS_NAMES.flatMap((axis) =>
    [
      "target",
      "reference",
      "measured",
      "tracking_error",
      "reference_velocity",
      "velocity",
      "reference_acceleration",
      "wrench_command",
      "wrench_achieved",
      "integral",
      "disturbance",
    ].map((suffix) => `${axis}.${suffix}`),
  ),
  ...Array.from({ length: NUM_THRUSTERS }, (_, i) => [`thruster_${i}.command`, `thruster_${i}.force`]).flat(),
  "altitude",
  "state_age",
];

export type Series = { t: number[]; v: number[] };

/** Samples of every signal, kept for a window of time. */
export class SignalBuffer {
  #series = new Map<string, Series>();
  #latest = -Infinity;
  windowS: number;

  constructor(windowS: number) {
    this.windowS = windowS;
  }

  /** The time [s] of the newest sample. */
  get latest(): number {
    return this.#latest;
  }

  add(t: number, values: Record<string, number>): void {
    if (t < this.#latest - this.windowS) {
      return;
    }
    this.#latest = Math.max(this.#latest, t);
    for (const [name, value] of Object.entries(values)) {
      let series = this.#series.get(name);
      if (!series) {
        series = { t: [], v: [] };
        this.#series.set(name, series);
      }
      series.t.push(t);
      series.v.push(value);
    }
    this.trim();
  }

  /** Drops samples older than the window. */
  trim(): void {
    const oldest = this.#latest - this.windowS;
    for (const series of this.#series.values()) {
      let drop = 0;
      while (drop < series.t.length && series.t[drop]! < oldest) {
        drop++;
      }
      if (drop > 0) {
        series.t.splice(0, drop);
        series.v.splice(0, drop);
      }
    }
  }

  series(name: string): Series | undefined {
    return this.#series.get(name);
  }

  latestValue(name: string): number | undefined {
    const series = this.#series.get(name);
    return series?.v[series.v.length - 1];
  }

  /** The value of `name` at `t`: the last sample at or before it. */
  valueAt(name: string, t: number): number | undefined {
    const series = this.#series.get(name);
    if (!series || series.t.length === 0 || t < series.t[0]!) {
      return undefined;
    }
    let low = 0;
    let high = series.t.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (series.t[mid]! <= t) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return series.v[low];
  }

  names(): string[] {
    return [...this.#series.keys()].sort();
  }

  clear(): void {
    this.#series.clear();
    this.#latest = -Infinity;
  }

  /** The named signals as CSV, one row per sample time, relative to the newest sample. */
  csv(names: readonly string[]): string {
    const times = new Set<number>();
    for (const name of names) {
      for (const t of this.#series.get(name)?.t ?? []) {
        times.add(t);
      }
    }
    const rows = [["t", ...names].join(",")];
    for (const t of [...times].sort((a, b) => a - b)) {
      const values = names.map((name) => {
        const series = this.#series.get(name);
        const index = series?.t.indexOf(t) ?? -1;
        return index >= 0 ? String(series!.v[index]) : "";
      });
      rows.push([(t - this.#latest).toFixed(4), ...values].join(","));
    }
    return `${rows.join("\n")}\n`;
  }
}
