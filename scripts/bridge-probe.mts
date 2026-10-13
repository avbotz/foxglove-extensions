// A smoke test of what the extensions rely on, against a running foxglove_bridge (the simulator
// or the vehicle): the topics and services they use, the node's parameter services with CDR
// requests, and client publishing of MotionSetpoint with common/msgs.ts's own definitions, which
// sub_control must acknowledge. It sets gains.x and restores it, sends one HOLD on every axis,
// and re-zeroes the pose, so run it with the vehicle holding still.
//
//   pnpm run probe [ws://host:8765] [foxglove.sdk.v1]
import { parse } from "@foxglove/rosmsg";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import WebSocket from "ws";

import {
  MOTION_SETPOINT_DATATYPES,
  MOTION_SETPOINT_SCHEMA,
  holdAllSetpoint,
} from "../common/msgs.ts";

const url = process.argv[2] ?? "ws://localhost:8765";
const NS = "/marlin_v3";
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args);

type Channel = { id: number; topic: string; encoding: string; schemaName: string; schema: string };
type Service = { id: number; name: string; type: string; request?: any; response?: any; requestSchema?: string; responseSchema?: string };

const channels = new Map<number, Channel>();
const services = new Map<string, Service>();
const subscriptions = new Map<number, Channel>();
const pendingCalls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; service: Service }>();
let serverInfo: any;
let nextCall = 1;
let nextSub = 1;

const ws = new WebSocket(url, [process.argv[3] ?? "foxglove.sdk.v1"], { perMessageDeflate: false });
ws.binaryType = "arraybuffer";
const open = new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = (e: any) => reject(new Error(`websocket error ${String(e?.message ?? e?.error ?? e)}`));
});

function send(json: object) {
  ws.send(JSON.stringify(json));
}

const statusMessages: any[] = [];
ws.onmessage = (event) => {
  if (typeof event.data === "string") {
    const msg = JSON.parse(event.data);
    if (msg.op === "serverInfo") {
      serverInfo = msg;
    } else if (msg.op === "advertise") {
      for (const c of msg.channels) channels.set(c.id, c);
    } else if (msg.op === "advertiseServices") {
      for (const s of msg.services) services.set(s.name, s);
    } else if (msg.op === "serviceCallFailure") {
      pendingCalls.get(msg.callId)?.reject(new Error(`service call failed: ${msg.message}`));
      pendingCalls.delete(msg.callId);
    } else if (msg.op === "status") {
      log(`[bridge status ${msg.level}] ${msg.message}`);
    }
    return;
  }
  const bytes = new Uint8Array(event.data as ArrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const op = bytes[0];
  if (op === 1) {
    const subId = view.getUint32(1, true);
    const channel = subscriptions.get(subId);
    if (!channel) return;
    const payload = bytes.subarray(1 + 4 + 8);
    const reader = new MessageReader(parse(channel.schema, { ros2: true }));
    statusMessages.push(reader.readMessage(payload));
  } else if (op === 3) {
    const serviceId = view.getUint32(1, true);
    const callId = view.getUint32(5, true);
    const encLen = view.getUint32(9, true);
    const payload = bytes.subarray(13 + encLen);
    const pending = pendingCalls.get(callId);
    if (!pending) return;
    pendingCalls.delete(callId);
    const schema = pending.service.response?.schema ?? pending.service.responseSchema;
    const reader = new MessageReader(parse(schema, { ros2: true }));
    pending.resolve(reader.readMessage(payload));
  }
};

function callService(name: string, request: object): Promise<any> {
  const service = services.get(name);
  if (!service) throw new Error(`no service ${name}`);
  const schema = service.request?.schema ?? service.requestSchema;
  const encoding = service.request?.encoding ?? "cdr";
  const writer = new MessageWriter(parse(schema, { ros2: true }));
  const payload = writer.writeMessage(request);
  const enc = new TextEncoder().encode(encoding);
  const header = new Uint8Array(1 + 4 + 4 + 4 + enc.length);
  const hv = new DataView(header.buffer);
  header[0] = 2;
  const callId = nextCall++;
  hv.setUint32(1, service.id, true);
  hv.setUint32(5, callId, true);
  hv.setUint32(9, enc.length, true);
  header.set(enc, 13);
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header);
  frame.set(payload, header.length);
  return new Promise((resolve, reject) => {
    pendingCalls.set(callId, { resolve, reject, service });
    ws.send(frame);
    setTimeout(() => {
      if (pendingCalls.delete(callId)) reject(new Error(`${name}: no reply in 10 s`));
    }, 10000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function paramValue(type: number, field: string, value: unknown) {
  return {
    type,
    bool_value: false,
    integer_value: 0,
    double_value: 0,
    string_value: "",
    byte_array_value: new Uint8Array(0),
    bool_array_value: [],
    integer_array_value: new BigInt64Array(0),
    double_array_value: [],
    string_array_value: [],
    [field]: value,
  };
}

async function main() {
  await open;
  log("connected to", url);
  await sleep(2500);
  log("server:", serverInfo?.name, "capabilities:", serverInfo?.capabilities, "encodings:", serverInfo?.supportedEncodings);
  for (const topic of [`${NS}/control/status`, `${NS}/motion_setpoint`, `${NS}/vision/detections`, `${NS}/odometry/filtered`, `${NS}/altitude`, `${NS}/front_camera/image_color/compressed`]) {
    const channel = [...channels.values()].find((c) => c.topic === topic);
    log(`topic ${topic}: ${channel ? `${channel.schemaName} (${channel.encoding})` : "NOT ADVERTISED"}`);
  }
  for (const name of ["list_parameters", "get_parameters", "set_parameters", "reset_pose"]) {
    const s = services.get(`${NS}/sub_control/${name}`);
    log(`service ${name}: ${s ? `${s.type} request encoding ${s.request?.encoding ?? "(legacy)"}` : "NOT ADVERTISED"}`);
  }

  // Parameters through the node's services.
  const listed = await callService(`${NS}/sub_control/list_parameters`, { prefixes: [], depth: 0 });
  const names: string[] = listed.result.names;
  log(`list_parameters: ${names.length} names, e.g. ${names.slice(0, 5).join(", ")}`);
  const got = await callService(`${NS}/sub_control/get_parameters`, { names: ["gains.x", "failed_thrusters", "control_rate_hz", "robot_name"] });
  const gainsX = Array.from(got.values[0].double_array_value as Float64Array);
  log("get_parameters gains.x:", got.values[0].type, gainsX, "failed_thrusters:", got.values[1].type, Array.from(got.values[1].integer_array_value), "control_rate_hz:", got.values[2].double_value, "robot_name:", got.values[3].string_value);
  const set = await callService(`${NS}/sub_control/set_parameters`, {
    parameters: [
      { name: "gains.x", value: paramValue(8, "double_array_value", [3, 1, 3]) },
      { name: "failed_thrusters", value: paramValue(7, "integer_array_value", new BigInt64Array(0)) },
      { name: "control_rate_hz", value: paramValue(3, "double_value", 60) },
    ],
  });
  log("set_parameters results:", set.results.map((r: any) => `${r.successful ? "ok" : "REJECTED"}${r.reason ? ` (${r.reason})` : ""}`));
  const check = await callService(`${NS}/sub_control/get_parameters`, { names: ["gains.x"] });
  log("gains.x now:", Array.from(check.values[0].double_array_value));
  const restore = await callService(`${NS}/sub_control/set_parameters`, { parameters: [{ name: "gains.x", value: paramValue(8, "double_array_value", gainsX) }] });
  log("restored gains.x:", restore.results[0].successful, Array.from((await callService(`${NS}/sub_control/get_parameters`, { names: ["gains.x"] })).values[0].double_array_value));

  // Client publishing with the extension's definitions.
  const status = [...channels.values()].find((c) => c.topic === `${NS}/control/status`);
  if (!status) throw new Error("no control/status channel");
  const subId = nextSub++;
  subscriptions.set(subId, status);
  send({ op: "subscribe", subscriptions: [{ id: subId, channelId: status.id }] });
  send({ op: "advertise", channels: [{ id: 1, topic: `${NS}/motion_setpoint`, encoding: "cdr", schemaName: MOTION_SETPOINT_SCHEMA }] });
  const root = MOTION_SETPOINT_DATATYPES.get(MOTION_SETPOINT_SCHEMA)!;
  const definitions = [
    { definitions: root.definitions },
    ...[...MOTION_SETPOINT_DATATYPES.entries()].filter(([name]) => name !== MOTION_SETPOINT_SCHEMA).map(([name, d]) => ({ name, definitions: d.definitions })),
  ];
  const writer = new MessageWriter(definitions as any);
  // Wait for the controller to arm (the sim releases the kill switch after 6 s).
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const last = statusMessages[statusMessages.length - 1];
    if (last?.armed) break;
    await sleep(500);
  }
  const before = statusMessages[statusMessages.length - 1];
  log(`control/status: ${statusMessages.length} messages; killed=${before?.killed} armed=${before?.armed} failsafe=${before?.failsafe} command_id=${before?.command_id}`);
  const publishAndCheck = async (id: number) => {
    const message = holdAllSetpoint();
    message.id = id;
    message.timeout = 0;
    const payload = writer.writeMessage(message);
    const frame = new Uint8Array(1 + 4 + payload.length);
    frame[0] = 1;
    new DataView(frame.buffer).setUint32(1, 1, true);
    frame.set(payload, 5);
    ws.send(frame);
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const ack = statusMessages.find((m) => Number(m.command_id) === id);
      if (ack) return ack;
      await sleep(100);
    }
    return undefined;
  };
  const ack = await publishAndCheck(4242);
  log(`published MotionSetpoint id 4242 (${writer.writeMessage(holdAllSetpoint()).byteLength} bytes): ${ack ? `acknowledged, command_rejected=${ack.command_rejected}` : "NOT ACKNOWLEDGED in 5 s"}`);
  // The same message a field short, as the old extension sent it: it must not be acknowledged.
  const shortDefinitions = [{ definitions: root.definitions.filter((f: any) => f.name !== "id") }, ...definitions.slice(1)];
  const shortWriter = new MessageWriter(shortDefinitions as any);
  const shortPayload = shortWriter.writeMessage({ ...holdAllSetpoint(), id: undefined });
  const frame = new Uint8Array(1 + 4 + shortPayload.length);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(1, 1, true);
  frame.set(shortPayload, 5);
  const countBefore = statusMessages.length;
  ws.send(frame);
  await sleep(2000);
  const after = statusMessages.slice(countBefore);
  log(`published the old (${shortPayload.byteLength}-byte) message: status command_ids seen since: ${[...new Set(after.map((m) => String(m.command_id)))].join(",")}`);
  const reset = await callService(`${NS}/sub_control/reset_pose`, {});
  log("reset_pose:", reset.success, reset.message);
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  log("FAILED:", e);
  process.exit(1);
});
