// ROS 2 parameters of any node, through the node's own parameter services (rcl_interfaces)
// called over foxglove_bridge. The services carry each value with its declared type, so a double
// array of whole numbers stays a double array; the bridge's parameter API would turn it into an
// integer array, which the node rejects.

import { PanelExtensionContext } from "@foxglove/extension";

import { record, stringOr } from "./panel";

// rcl_interfaces/msg/ParameterType
export const PARAMETER_NOT_SET = 0;
export const PARAMETER_BOOL = 1;
export const PARAMETER_INTEGER = 2;
export const PARAMETER_DOUBLE = 3;
export const PARAMETER_STRING = 4;
export const PARAMETER_BYTE_ARRAY = 5;
export const PARAMETER_BOOL_ARRAY = 6;
export const PARAMETER_INTEGER_ARRAY = 7;
export const PARAMETER_DOUBLE_ARRAY = 8;
export const PARAMETER_STRING_ARRAY = 9;

export const TYPE_NAMES: Record<number, string> = {
  [PARAMETER_NOT_SET]: "not set",
  [PARAMETER_BOOL]: "bool",
  [PARAMETER_INTEGER]: "integer",
  [PARAMETER_DOUBLE]: "double",
  [PARAMETER_STRING]: "string",
  [PARAMETER_BYTE_ARRAY]: "byte array",
  [PARAMETER_BOOL_ARRAY]: "bool array",
  [PARAMETER_INTEGER_ARRAY]: "integer array",
  [PARAMETER_DOUBLE_ARRAY]: "double array",
  [PARAMETER_STRING_ARRAY]: "string array",
};

export type ParamValue = boolean | number | string | boolean[] | number[] | string[] | undefined;
export type RosParam = { type: number; value: ParamValue };

export function isArrayType(type: number): boolean {
  return type >= PARAMETER_BYTE_ARRAY;
}

export function isNumericType(type: number): boolean {
  return (
    type === PARAMETER_INTEGER ||
    type === PARAMETER_DOUBLE ||
    type === PARAMETER_BYTE_ARRAY ||
    type === PARAMETER_INTEGER_ARRAY ||
    type === PARAMETER_DOUBLE_ARRAY
  );
}

function numbers(value: unknown): number[] {
  return Array.from((value ?? []) as ArrayLike<number | bigint>, (v) => Number(v));
}

/** A rcl_interfaces/msg/ParameterValue as a RosParam. */
export function fromParameterValue(message: unknown): RosParam {
  const m = record(message);
  const type = Number(m.type);
  switch (type) {
    case PARAMETER_BOOL:
      return { type, value: m.bool_value === true };
    case PARAMETER_INTEGER:
      return { type, value: Number(m.integer_value) };
    case PARAMETER_DOUBLE:
      return { type, value: Number(m.double_value) };
    case PARAMETER_STRING:
      return { type, value: stringOr(m.string_value, "") };
    case PARAMETER_BYTE_ARRAY:
      return { type, value: numbers(m.byte_array_value) };
    case PARAMETER_BOOL_ARRAY:
      return {
        type,
        value: Array.from((m.bool_array_value ?? []) as ArrayLike<unknown>, (v) => v === true),
      };
    case PARAMETER_INTEGER_ARRAY:
      return { type, value: numbers(m.integer_array_value) };
    case PARAMETER_DOUBLE_ARRAY:
      return { type, value: numbers(m.double_array_value) };
    case PARAMETER_STRING_ARRAY:
      return {
        type,
        value: Array.from((m.string_array_value ?? []) as ArrayLike<unknown>, String),
      };
    default:
      return { type: PARAMETER_NOT_SET, value: undefined };
  }
}

/** A RosParam as a complete rcl_interfaces/msg/ParameterValue, every field present. */
export function toParameterValue(param: RosParam): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: param.type,
    bool_value: false,
    integer_value: 0,
    double_value: 0,
    string_value: "",
    byte_array_value: new Uint8Array(0),
    bool_array_value: [],
    integer_array_value: new BigInt64Array(0),
    double_array_value: [],
    string_array_value: [],
  };
  const { type, value } = param;
  if (type === PARAMETER_BOOL) {
    message.bool_value = value === true;
  } else if (type === PARAMETER_INTEGER) {
    message.integer_value = Math.trunc(Number(value));
  } else if (type === PARAMETER_DOUBLE) {
    message.double_value = Number(value);
  } else if (type === PARAMETER_STRING) {
    message.string_value = String(value ?? "");
  } else if (type === PARAMETER_BYTE_ARRAY) {
    message.byte_array_value = Uint8Array.from(numbers(value));
  } else if (type === PARAMETER_BOOL_ARRAY) {
    message.bool_array_value = Array.isArray(value) ? value.map((v) => v === true) : [];
  } else if (type === PARAMETER_INTEGER_ARRAY) {
    message.integer_array_value = BigInt64Array.from(numbers(value), (v) => BigInt(Math.trunc(v)));
  } else if (type === PARAMETER_DOUBLE_ARRAY) {
    message.double_array_value = numbers(value);
  } else if (type === PARAMETER_STRING_ARRAY) {
    message.string_array_value = Array.isArray(value) ? value.map(String) : [];
  }
  return message;
}

/** Whether two parameters hold the same value, doubles to within rounding. */
export function sameParam(a: RosParam, b: RosParam): boolean {
  if (a.type !== b.type) {
    return false;
  }
  const close = (x: unknown, y: unknown) =>
    typeof x === "number" && typeof y === "number"
      ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))
      : x === y;
  if (Array.isArray(a.value) || Array.isArray(b.value)) {
    const x: unknown[] = Array.isArray(a.value) ? a.value : [];
    const y: unknown[] = Array.isArray(b.value) ? b.value : [];
    return x.length === y.length && x.every((v, i) => close(v, y[i]));
  }
  return close(a.value, b.value);
}

async function call(context: PanelExtensionContext, service: string, request: unknown): Promise<unknown> {
  if (context.callService == undefined) {
    throw new Error("This connection cannot call services");
  }
  return await context.callService(service, request);
}

/** The names of every parameter `node` declares. */
export async function listParameters(
  context: PanelExtensionContext,
  node: string,
): Promise<string[]> {
  const response = record(await call(context, `${node}/list_parameters`, { prefixes: [], depth: 0 }));
  const names = record(response.result).names;
  return Array.isArray(names) ? names.map(String).sort() : [];
}

export async function getParameters(
  context: PanelExtensionContext,
  node: string,
  names: readonly string[],
): Promise<Map<string, RosParam>> {
  if (names.length === 0) {
    return new Map();
  }
  const response = record(await call(context, `${node}/get_parameters`, { names }));
  const values: unknown[] = Array.isArray(response.values) ? response.values : [];
  return new Map(names.map((name, index) => [name, fromParameterValue(values[index])]));
}

export type SetResult = { name: string; successful: boolean; reason: string };

/** Sets parameters one by one (not atomically), reporting each result. */
export async function setParameters(
  context: PanelExtensionContext,
  node: string,
  params: readonly (readonly [string, RosParam])[],
): Promise<SetResult[]> {
  if (params.length === 0) {
    return [];
  }
  const response = record(
    await call(context, `${node}/set_parameters`, {
      parameters: params.map(([name, param]) => ({ name, value: toParameterValue(param) })),
    }),
  );
  const results: unknown[] = Array.isArray(response.results) ? response.results : [];
  return params.map(([name], index) => {
    const result = record(results[index]);
    return {
      name,
      successful: result.successful === true,
      reason: stringOr(result.reason, result.successful === true ? "" : "no reply"),
    };
  });
}
