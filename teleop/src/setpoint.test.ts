import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import { describe, expect, it } from "vitest";

import { SetpointForm, buildSetpoint, defaultForm } from "./setpoint";
import {
  DEG,
  HOLD,
  KEEP,
  MOTION_SETPOINT_DATATYPES,
  MOTION_SETPOINT_SCHEMA,
  POSITION,
  VELOCITY,
  WORLD,
  X,
  Y,
  YAW,
  Z,
  holdAllSetpoint,
} from "../../common/msgs";

function form(edit: (form: SetpointForm) => void): SetpointForm {
  const result = defaultForm();
  edit(result);
  return result;
}

function built(result: ReturnType<typeof buildSetpoint>) {
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}

const current = { target: [1, 2, -1.5, 0, 0, 90 * DEG], altitude: false };

describe("buildSetpoint", () => {
  it("sends absolute targets with angles in radians", () => {
    const { message, warnings } = built(
      buildSetpoint(
        form((f) => {
          f.rows[Z] = { mode: POSITION, position: -1, velocity: 0, effort: 0 };
          f.rows[YAW] = { mode: POSITION, position: 45, velocity: 0, effort: 0 };
        }),
        undefined,
      ),
    );
    expect(message.mode).toEqual([KEEP, KEEP, POSITION, KEEP, KEEP, POSITION]);
    expect(message.position[Z]).toBe(-1);
    expect(message.position[YAW]).toBeCloseTo(Math.PI / 4);
    expect(warnings).toEqual([]);
  });

  it("refuses x and y in different modes, and an empty command", () => {
    expect(
      buildSetpoint(
        form((f) => (f.rows[X].mode = VELOCITY)),
        undefined,
      ),
    ).toHaveProperty("error");
    expect(buildSetpoint(defaultForm(), undefined)).toHaveProperty("error");
  });

  it("measures heading-relative moves from the current target", () => {
    const { message } = built(
      buildSetpoint(
        form((f) => {
          f.positionFrame = "heading";
          f.rows[X] = { mode: POSITION, position: 1, velocity: 0, effort: 0 };
          f.rows[Y] = { mode: POSITION, position: 0, velocity: 0, effort: 0 };
          f.rows[YAW] = { mode: POSITION, position: 90, velocity: 0, effort: 0 };
        }),
        current,
      ),
    );
    // Facing +y (yaw 90°), 1 m forward is +1 in odom y.
    expect(message.position[X]).toBeCloseTo(1);
    expect(message.position[Y]).toBeCloseTo(3);
    expect(message.position[YAW]).toBeCloseTo(Math.PI); // wrapped
  });

  it("needs a status for relative targets, with the same z reference", () => {
    const relativeZ = form((f) => {
      f.positionFrame = "relative";
      f.rows[Z] = { mode: POSITION, position: -0.5, velocity: 0, effort: 0 };
    });
    expect(buildSetpoint(relativeZ, undefined)).toHaveProperty("error");
    expect(built(buildSetpoint(relativeZ, current)).message.position[Z]).toBeCloseTo(-2);
    expect(buildSetpoint({ ...relativeZ, altitude: true }, current)).toHaveProperty("error");
  });

  it("warns about latching streams and surfacing", () => {
    const { message, warnings } = built(
      buildSetpoint(
        form((f) => {
          f.timeout = 0;
          f.velocityFrame = WORLD;
          f.rows[X] = { mode: VELOCITY, position: 0, velocity: 0.2, effort: 0 };
          f.rows[Y] = { mode: VELOCITY, position: 0, velocity: 0, effort: 0 };
          f.rows[Z] = { mode: POSITION, position: 0.5, velocity: 0, effort: 0 };
        }),
        undefined,
      ),
    );
    expect(message.velocity_frame).toBe(WORLD);
    expect(warnings).toHaveLength(2);
  });
});

describe("MOTION_SETPOINT_DATATYPES", () => {
  it("serializes a MotionSetpoint to CDR and back", () => {
    // The definition list the app builds from the `datatypes` advertise option.
    const root = MOTION_SETPOINT_DATATYPES.get(MOTION_SETPOINT_SCHEMA)!;
    const definitions = [
      { definitions: root.definitions },
      ...[...MOTION_SETPOINT_DATATYPES.entries()]
        .filter(([name]) => name !== MOTION_SETPOINT_SCHEMA)
        .map(([name, definition]) => ({ name, definitions: definition.definitions })),
    ];
    const message = holdAllSetpoint();
    message.mode[Z] = POSITION;
    message.position[Z] = -1.25;
    message.timeout = 0.5;
    message.altitude = true;
    message.id = 42;

    const bytes = new MessageWriter(definitions).writeMessage(message);
    // After the 4-byte encapsulation header: stamp 8 and frame_id 4 + 1 -> 13, mode -> 19, the
    // doubles aligned to 24, 18 of them -> 168, velocity_frame and altitude -> 170, timeout
    // aligned to 176 -> 184, id -> 192. Same as rclpy's serialize_message; a message 8 bytes
    // short (no id) fails to deserialize in the controller and is dropped.
    expect(bytes.byteLength).toBe(4 + 192);
    const decoded = new MessageReader(definitions).readMessage<Record<string, unknown>>(bytes);
    expect(Array.from(decoded.mode as Uint8Array)).toEqual([
      HOLD,
      HOLD,
      POSITION,
      HOLD,
      HOLD,
      HOLD,
    ]);
    expect(Array.from(decoded.position as Float64Array)).toEqual([0, 0, -1.25, 0, 0, 0]);
    expect(decoded.altitude).toBe(true);
    expect(decoded.timeout).toBe(0.5);
    expect(decoded.id).toBe(42n);
  });
});
