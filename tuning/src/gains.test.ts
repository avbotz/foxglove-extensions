import { describe, expect, it } from "vitest";

import {
  bandwidthOf,
  changedParams,
  elementLabels,
  gainsFor,
  groupOf,
  parseParam,
  toYaml,
  withElement,
} from "./gains";
import {
  PARAMETER_BOOL,
  PARAMETER_DOUBLE,
  PARAMETER_DOUBLE_ARRAY,
  PARAMETER_INTEGER_ARRAY,
  PARAMETER_STRING,
  RosParam,
  fromParameterValue,
  sameParam,
  toParameterValue,
} from "../../common/params";

const doubles = (value: number[]): RosParam => ({ type: PARAMETER_DOUBLE_ARRAY, value });

describe("bandwidth shortcut", () => {
  it("round-trips a critically damped triple", () => {
    expect(gainsFor(0.8)).toEqual([1.92, 0.512, 2.4]);
    expect(bandwidthOf([1.92, 0.512, 2.4])).toBe(0.8);
    expect(bandwidthOf([1.92, 0.9, 2.4])).toBeUndefined();
    expect(bandwidthOf([0, 0, 0])).toBeUndefined();
  });
});

describe("grouping and labels", () => {
  it("groups by prefix with the thruster faults together", () => {
    expect(groupOf("gains.x").title).toBe("Gains");
    expect(groupOf("failed_thrusters").title).toBe("Thrusters");
    expect(groupOf("power_limit").title).toBe("General");
    expect(groupOf("gains.x").order).toBeLessThan(groupOf("safety.state_timeout").order);
  });

  it("labels short double arrays", () => {
    expect(elementLabels("gains.z", doubles([3, 1, 3]))).toEqual(["kp", "ki", "kd"]);
    expect(elementLabels("trajectory.yaw", doubles([0.6, 0.5, 1]))).toEqual(["v max", "a max", "j max"]);
    expect(elementLabels("model.linear_drag", doubles([1, 2, 3, 4, 5, 6]))).toEqual([
      "x",
      "y",
      "z",
      "roll",
      "pitch",
      "yaw",
    ]);
    expect(elementLabels("failed_thrusters", { type: PARAMETER_INTEGER_ARRAY, value: [] })).toBeUndefined();
  });
});

describe("parseParam", () => {
  it("parses each type and reports what does not fit", () => {
    expect(parseParam("[3, 5]", PARAMETER_INTEGER_ARRAY)).toEqual({ type: PARAMETER_INTEGER_ARRAY, value: [3, 5] });
    expect(parseParam("", PARAMETER_INTEGER_ARRAY)).toEqual({ type: PARAMETER_INTEGER_ARRAY, value: [] });
    expect(parseParam("1.5", PARAMETER_INTEGER_ARRAY)).toHaveProperty("error");
    expect(parseParam("true", PARAMETER_BOOL)).toEqual({ type: PARAMETER_BOOL, value: true });
    expect(parseParam("yes", PARAMETER_BOOL)).toHaveProperty("error");
    expect(parseParam(" 0.5 ", PARAMETER_DOUBLE)).toEqual({ type: PARAMETER_DOUBLE, value: 0.5 });
    expect(parseParam("", PARAMETER_DOUBLE)).toHaveProperty("error");
    expect(parseParam("marlin", PARAMETER_STRING)).toEqual({ type: PARAMETER_STRING, value: "marlin" });
  });

  it("sets one element of an array", () => {
    expect(withElement(doubles([1, 2, 3]), 1, 9)).toEqual(doubles([1, 9, 3]));
  });
});

describe("profile export", () => {
  it("nests dotted names and keeps doubles as doubles", () => {
    const params = new Map<string, RosParam>([
      ["gains.x", doubles([3, 1, 3])],
      ["gains.anti_windup", { type: PARAMETER_DOUBLE, value: 5 }],
      ["power_limit", { type: PARAMETER_DOUBLE, value: 0.6 }],
      ["safety.require_kill_cycle", { type: PARAMETER_BOOL, value: true }],
      ["robot_name", { type: PARAMETER_STRING, value: "marlin_v3" }],
    ]);
    expect(toYaml(params)).toBe(
      [
        "/**:",
        "  ros__parameters:",
        "    gains:",
        "      anti_windup: 5.0",
        "      x: [3.0, 1.0, 3.0]",
        "    power_limit: 0.6",
        "    robot_name: 'marlin_v3'",
        "    safety:",
        "      require_kill_cycle: true",
        "",
      ].join("\n"),
    );
  });

  it("exports what changed, never the layout or the fault state", () => {
    const baseline = new Map<string, RosParam>([
      ["gains.x", doubles([3, 1, 3])],
      ["gains.y", doubles([3, 1, 3])],
      ["thruster_health", doubles([1, 1, 1, 1, 1, 1, 1, 1])],
      ["control_rate_hz", { type: PARAMETER_DOUBLE, value: 50 }],
    ]);
    const current = new Map<string, RosParam>([
      ["gains.x", doubles([3, 1, 3.0000000001])],
      ["gains.y", doubles([4, 1, 3])],
      ["thruster_health", doubles([1, 1, 1, 1, 1, 1, 1, 0])],
      ["control_rate_hz", { type: PARAMETER_DOUBLE, value: 100 }],
    ]);
    expect([...changedParams(current, baseline).keys()]).toEqual(["gains.y"]);
    expect([...changedParams(current, undefined).keys()]).toEqual(["gains.x", "gains.y"]);
  });
});

describe("parameter messages", () => {
  it("round-trips through rcl_interfaces/msg/ParameterValue", () => {
    const param = doubles([1.5, 2]);
    expect(sameParam(fromParameterValue(toParameterValue(param)), param)).toBe(true);
    const ints = { type: PARAMETER_INTEGER_ARRAY, value: [3, 5] };
    const message = toParameterValue(ints);
    expect(message.integer_array_value).toBeInstanceOf(BigInt64Array);
    expect(sameParam(fromParameterValue(message), ints)).toBe(true);
    expect(fromParameterValue({ type: 2, integer_value: 7n })).toEqual({ type: 2, value: 7 });
  });
});
