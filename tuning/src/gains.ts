// The Gains panel's logic: how sub_control's parameters are grouped, edited and exported as a
// profile, and the bandwidth shortcut. No React or Foxglove here, so it can be unit tested.

import { AXIS_NAMES } from "../../common/msgs";
import {
  PARAMETER_BOOL,
  PARAMETER_BOOL_ARRAY,
  PARAMETER_BYTE_ARRAY,
  PARAMETER_DOUBLE,
  PARAMETER_DOUBLE_ARRAY,
  PARAMETER_INTEGER,
  PARAMETER_INTEGER_ARRAY,
  PARAMETER_STRING,
  PARAMETER_STRING_ARRAY,
  RosParam,
  sameParam,
} from "../../common/params";

export const DEFAULT_NODE = "/marlin_v3/sub_control";

/** Declared read-only by sub_control: the loop rate and the thruster layout. */
export const READ_ONLY = new Set([
  "control_rate_hz",
  "robot_name",
  "allocation.thruster_positions",
  "allocation.thruster_directions",
  "allocation.thruster_reversed",
]);

/** Fault state set by hand, not tuning: left out of the profile. */
export const NOT_SAVED = new Set(["thruster_health", "failed_thrusters"]);

const GROUPS: [string, string][] = [
  ["gains", "Gains"],
  ["trajectory", "Trajectory"],
  ["", "General"],
  ["feedforward", "Feedforward"],
  ["observer", "Disturbance observer"],
  ["model", "Vehicle model"],
  ["allocation", "Allocation"],
  ["thrusters", "Thrusters"],
  ["safety", "Safety"],
];

export function groupOf(name: string): { order: number; title: string } {
  const prefix = NOT_SAVED.has(name)
    ? "thrusters"
    : name.includes(".")
      ? name.slice(0, name.indexOf("."))
      : "";
  const index = GROUPS.findIndex(([key]) => key === prefix);
  return index >= 0
    ? { order: index, title: GROUPS[index]![1] }
    : { order: GROUPS.length, title: prefix.replace(/_/g, " ") };
}

export function isGain(name: string, param: RosParam): boolean {
  return (
    /^gains\.(x|y|z|roll|pitch|yaw)$/.test(name) &&
    param.type === PARAMETER_DOUBLE_ARRAY &&
    Array.isArray(param.value) &&
    param.value.length === 3
  );
}

/** Labels of a short double array's elements, or undefined to edit it as text. */
export function elementLabels(name: string, param: RosParam): string[] | undefined {
  if (param.type !== PARAMETER_DOUBLE_ARRAY || !Array.isArray(param.value)) {
    return undefined;
  }
  const length = param.value.length;
  if (length === 0 || length > 8) {
    return undefined;
  }
  if (isGain(name, param)) {
    return ["kp", "ki", "kd"];
  }
  if (/^trajectory\.(horizontal|vertical|roll|pitch|yaw)$/.test(name) && length === 3) {
    return ["v max", "a max", "j max"];
  }
  if (name === "model.inertia" && length === 3) {
    return ["roll", "pitch", "yaw"];
  }
  if (length === 6) {
    return [...AXIS_NAMES];
  }
  if (length === 3) {
    return ["x", "y", "z"];
  }
  return Array.from({ length }, (_, index) => String(index));
}

/** A critically damped triple pole at -ω: [3ω², ω³, 3ω] (docs/control.md). */
export function gainsFor(bandwidth: number): [number, number, number] {
  return [3 * bandwidth * bandwidth, bandwidth ** 3, 3 * bandwidth].map((value) =>
    Number(value.toPrecision(4)),
  ) as [number, number, number];
}

/** The bandwidth a gain triple was set from, if it is one. */
export function bandwidthOf(gains: readonly number[]): number | undefined {
  const bandwidth = (gains[2] ?? 0) / 3;
  if (!(bandwidth > 0)) {
    return undefined;
  }
  const expected = gainsFor(bandwidth);
  const close = (a: number | undefined, b: number) => Math.abs((a ?? NaN) - b) <= 0.02 * Math.abs(b);
  return close(gains[0], expected[0]) && close(gains[1], expected[1])
    ? Number(bandwidth.toPrecision(4))
    : undefined;
}

/** Up to six significant digits, the way the gains files are written. */
export function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : String(value);
}

export function formatParam(param: RosParam): string {
  const { value } = param;
  if (Array.isArray(value)) {
    return `[${value.map((v) => (typeof v === "number" ? formatNumber(v) : String(v))).join(", ")}]`;
  }
  if (typeof value === "number") {
    return formatNumber(value);
  }
  return value == undefined ? "" : String(value);
}

function parseNumbers(text: string): number[] | undefined {
  const inner = text.trim().replace(/^\[|\]$/g, "");
  if (inner.trim() === "") {
    return [];
  }
  const values = inner.split(/[\s,]+/).filter((part) => part !== "").map(Number);
  return values.every(Number.isFinite) ? values : undefined;
}

function parseBool(text: string): boolean | undefined {
  const lower = text.trim().toLowerCase();
  return lower === "true" || lower === "1" ? true : lower === "false" || lower === "0" ? false : undefined;
}

/** Text typed for a parameter of `type`, as that type; or why it does not fit. */
export function parseParam(text: string, type: number): RosParam | { error: string } {
  switch (type) {
    case PARAMETER_BOOL: {
      const value = parseBool(text);
      return value == undefined ? { error: "true or false" } : { type, value };
    }
    case PARAMETER_INTEGER: {
      const value = Number(text.trim());
      return Number.isInteger(value) && text.trim() !== ""
        ? { type, value }
        : { error: "a whole number" };
    }
    case PARAMETER_DOUBLE: {
      const value = Number(text.trim());
      return Number.isFinite(value) && text.trim() !== "" ? { type, value } : { error: "a number" };
    }
    case PARAMETER_STRING:
      return { type, value: text };
    case PARAMETER_BYTE_ARRAY:
    case PARAMETER_INTEGER_ARRAY: {
      const values = parseNumbers(text);
      return values?.every(Number.isInteger) === true
        ? { type, value: values }
        : { error: "whole numbers, separated by commas" };
    }
    case PARAMETER_DOUBLE_ARRAY: {
      const values = parseNumbers(text);
      return values ? { type, value: values } : { error: "numbers, separated by commas" };
    }
    case PARAMETER_BOOL_ARRAY: {
      const inner = text.trim().replace(/^\[|\]$/g, "");
      const parts = inner.trim() === "" ? [] : inner.split(/[\s,]+/).filter((p) => p !== "");
      const values = parts.map(parseBool);
      return values.every((v) => v != undefined)
        ? { type, value: values }
        : { error: "true or false, separated by commas" };
    }
    case PARAMETER_STRING_ARRAY: {
      const inner = text.trim().replace(/^\[|\]$/g, "");
      return { type, value: inner.trim() === "" ? [] : inner.split(",").map((s) => s.trim()) };
    }
    default:
      return { error: "cannot be edited" };
  }
}

/** `param` with element `index` of its array set to `value`. */
export function withElement(param: RosParam, index: number, value: number): RosParam {
  const values = Array.isArray(param.value) ? [...(param.value as number[])] : [];
  values[index] = value;
  return { type: param.type, value: values };
}

/** The writable parameters that differ from `baseline`; all of them without one. */
export function changedParams(
  params: ReadonlyMap<string, RosParam>,
  baseline: ReadonlyMap<string, RosParam> | undefined,
): Map<string, RosParam> {
  const changed = new Map<string, RosParam>();
  for (const [name, param] of params) {
    if (READ_ONLY.has(name) || NOT_SAVED.has(name)) {
      continue;
    }
    const before = baseline?.get(name);
    if (baseline == undefined || before == undefined || !sameParam(before, param)) {
      changed.set(name, param);
    }
  }
  return changed;
}

function yamlScalar(value: unknown, { double }: { double: boolean }): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return Number.isNaN(value) ? ".nan" : value > 0 ? ".inf" : "-.inf";
    }
    const text = formatNumber(value);
    // A double must read back as one: "3" would load as an integer and fail the type check.
    return double && !/[.e]/.test(text) ? `${text}.0` : text;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

type YamlTree = Map<string, YamlTree | RosParam>;

function yamlLines(tree: YamlTree, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, node] of tree) {
    if (node instanceof Map) {
      lines.push(`${indent}${key}:`, ...yamlLines(node, `${indent}  `));
      continue;
    }
    const double = node.type === PARAMETER_DOUBLE || node.type === PARAMETER_DOUBLE_ARRAY;
    const text = Array.isArray(node.value)
      ? `[${node.value.map((v) => yamlScalar(v, { double })).join(", ")}]`
      : yamlScalar(node.value, { double });
    lines.push(`${indent}${key}: ${text}`);
  }
  return lines;
}

/** The parameters laid out like sub_control's gains files: dotted names nested under ros__parameters. */
export function toYaml(params: ReadonlyMap<string, RosParam>): string {
  const tree: YamlTree = new Map();
  for (const name of [...params.keys()].sort()) {
    const parts = name.split(".");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      let child = node.get(part);
      if (!(child instanceof Map)) {
        child = new Map();
        node.set(part, child);
      }
      node = child;
    }
    node.set(parts[parts.length - 1]!, params.get(name)!);
  }
  return ["/**:", "  ros__parameters:", ...yamlLines(tree, "    "), ""].join("\n");
}
