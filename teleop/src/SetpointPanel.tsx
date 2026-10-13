// Compose one MotionSetpoint with a mode per axis: go to a pose, move at a set speed for a set
// time, push open loop, or hold. For step tests while tuning and for precise moves.

import { Immutable, PanelExtensionContext, SettingsTreeNodes, Topic } from "@foxglove/extension";
import { Fragment, ReactElement, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  AxisRow,
  PositionFrame,
  SetpointForm,
  buildSetpoint,
  defaultForm,
  isAngle,
} from "./setpoint";
import {
  AXIS_NAMES,
  AxisMode,
  DEFAULT_ODOMETRY_TOPIC,
  DEFAULT_RESET_SERVICE,
  DEFAULT_SETPOINT_TOPIC,
  DEFAULT_STATUS_TOPIC,
  DEG,
  EFFORT,
  HEADING,
  HOLD,
  KEEP,
  POSITION,
  Six,
  VELOCITY,
  VelocityFrame,
  WORLD,
  X,
  Y,
  Z,
  holdAllSetpoint,
  levelSetpoint,
  newCommandId,
  odometryPose,
} from "../../common/msgs";
import {
  fresh,
  numberOr,
  record,
  staleSeconds,
  stringOr,
  topicItems,
  useNow,
  usePanelData,
  useResetPose,
  useSetpointPublisher,
  useSettings,
} from "../../common/panel";
import {
  Button,
  Card,
  ConfirmButton,
  NumberInput,
  Segmented,
  StatusBar,
  format,
  modeName,
  theme,
} from "../../common/ui";

type Config = {
  topic: string;
  statusTopic: string;
  odometryTopic: string;
  resetService: string;
  form: SetpointForm;
};

const MODES: { value: AxisMode; label: string; title: string }[] = [
  { value: KEEP, label: "Keep", title: "Leave the axis as it is" },
  { value: POSITION, label: "Pos", title: "Move smoothly to a position and hold it" },
  { value: VELOCITY, label: "Vel", title: "Move at a speed until the timeout" },
  { value: HOLD, label: "Hold", title: "Stop smoothly and hold where it stops" },
  { value: EFFORT, label: "Effort", title: "Push open loop along the body axis until the timeout" },
];
const POSITION_FRAMES: { value: PositionFrame; label: string; title: string }[] = [
  { value: "absolute", label: "Absolute", title: "Odom coordinates" },
  { value: "relative", label: "Relative", title: "Offsets from the current target, odom axes" },
  {
    value: "heading",
    label: "Heading",
    title: "Offsets from the current target; x forward and y left along its heading",
  },
];
const AXIS_HINTS: Six<string> = ["+ forward", "+ left", "+ up", "+ right", "+ nose down", "+ left"];

function loadRow(saved: unknown): AxisRow {
  const row = record(saved);
  const mode = MODES.find(({ value }) => value === row.mode)?.value ?? KEEP;
  return {
    mode,
    position: numberOr(row.position, 0),
    velocity: numberOr(row.velocity, 0),
    effort: numberOr(row.effort, 0),
  };
}

function loadConfig(saved: unknown): Config {
  const s = record(saved);
  const form = record(s.form);
  const rows: unknown[] = Array.isArray(form.rows) ? form.rows : [];
  const defaults = defaultForm();
  const loaded = [0, 1, 2, 3, 4, 5].map((axis) => loadRow(rows[axis])) as Six<AxisRow>;
  loaded[Y].mode = loaded[X].mode;
  return {
    topic: stringOr(s.topic, DEFAULT_SETPOINT_TOPIC),
    statusTopic: stringOr(s.statusTopic, DEFAULT_STATUS_TOPIC),
    odometryTopic: stringOr(s.odometryTopic, DEFAULT_ODOMETRY_TOPIC),
    resetService: stringOr(s.resetService, DEFAULT_RESET_SERVICE),
    form: {
      rows: loaded,
      positionFrame:
        POSITION_FRAMES.find(({ value }) => value === form.positionFrame)?.value ??
        defaults.positionFrame,
      velocityFrame: form.velocityFrame === WORLD ? WORLD : HEADING,
      altitude: form.altitude === true,
      timeout: numberOr(form.timeout, defaults.timeout, 0),
    },
  };
}

const TOPIC_FIELDS = ["topic", "statusTopic", "odometryTopic", "resetService"] as const;

function applySetting(config: Config, path: readonly string[], value: unknown): Config {
  const [node, field] = path;
  const topicField = TOPIC_FIELDS.find((name) => name === field);
  if (node === "general" && topicField != undefined) {
    return { ...config, [topicField]: typeof value === "string" ? value.trim() : "" };
  }
  return config;
}

function buildSettingsTree(config: Config, topics: Immutable<Topic[]>): SettingsTreeNodes {
  return {
    general: {
      label: "Motion Setpoint",
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
          help: "nav_msgs/msg/Odometry: the measured pose",
        },
        resetService: {
          label: "Re-zero service",
          input: "string",
          value: config.resetService,
          help: "std_srvs/srv/Trigger that makes the current position and heading the origin",
        },
      },
    },
  };
}

function unit(axis: number, mode: AxisMode): string {
  const angle = isAngle(axis);
  switch (mode) {
    case POSITION:
      return angle ? "°" : "m";
    case VELOCITY:
      return angle ? "°/s" : "m/s";
    case EFFORT:
      return angle ? "N·m" : "N";
    case KEEP:
    case HOLD:
      return "";
  }
}

function fieldFor(mode: AxisMode): "position" | "velocity" | "effort" | undefined {
  return mode === POSITION
    ? "position"
    : mode === VELOCITY
      ? "velocity"
      : mode === EFFORT
        ? "effort"
        : undefined;
}

/** A pose value in the panel's units: m, or degrees for angles. */
function poseText(axis: number, value: number | undefined): string {
  if (value == undefined) {
    return "—";
  }
  return isAngle(axis) ? `${format(value / DEG, 1)}°` : `${format(value, 2)} m`;
}

function SetpointPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [config, setConfig] = useState(() => loadConfig(context.initialState));
  const data = usePanelData(context, {
    status: config.statusTopic,
    odometry: config.odometryTopic,
  });
  const t = theme(data.colorScheme);
  const now = useNow(500);
  const nodes = useMemo(() => buildSettingsTree(config, data.topics), [config, data.topics]);
  useSettings(context, config, nodes, applySetting, setConfig);
  const publisher = useSetpointPublisher(context, config.topic);
  const resetPose = useResetPose(context, config.resetService);
  const [result, setResult] = useState<{ text: string; color: string }[]>([]);
  // The id of the last command sent, to show sub_control's acknowledgment of it.
  const [sentId, setSentId] = useState<number | undefined>();

  const status = fresh(data.status, now);
  const odometry = fresh(data.odometry, now);
  const measured = useMemo(() => (odometry ? odometryPose(odometry) : undefined), [odometry]);
  const current = status ? { target: status.target, altitude: status.altitude } : undefined;
  const { form } = config;
  const preview = buildSetpoint(form, current);

  const setForm = (update: (form: SetpointForm) => SetpointForm) => {
    setConfig((previous) => ({ ...previous, form: update(previous.form) }));
  };
  const setRow = (axis: number, update: Partial<AxisRow>) => {
    setForm((previous) => {
      const rows = previous.rows.map((row) => ({ ...row })) as Six<AxisRow>;
      Object.assign(rows[axis]!, update);
      // x and y share a mode.
      if (update.mode != undefined && (axis === X || axis === Y)) {
        rows[X].mode = rows[Y].mode = update.mode;
      }
      return { ...previous, rows };
    });
  };

  const report = (failure: string | undefined, success: string, warnings: string[] = []) => {
    const time = new Date().toLocaleTimeString();
    setResult(
      failure != undefined
        ? [{ text: failure, color: t.danger }]
        : [
            { text: `${success} at ${time}`, color: t.ok },
            ...warnings.map((text) => ({ text, color: t.warn })),
          ],
    );
  };

  const send = () => {
    const built = buildSetpoint(form, current);
    if ("error" in built) {
      report(built.error, "");
      return;
    }
    const id = newCommandId();
    built.message.id = id;
    const failure = publisher.publish(built.message);
    setSentId(failure == undefined ? id : undefined);
    report(failure, "Sent", built.warnings);
  };

  const acknowledged =
    status != undefined && sentId != undefined && Number(status.command_id) === sentId
      ? status.command_rejected
        ? { text: "sub_control rejected it (its log says why)", color: t.danger }
        : { text: "sub_control took it up", color: t.ok }
      : undefined;

  /** Fills every position value from `pose` (odom, radians) as an absolute target. */
  const loadPose = (pose: ArrayLike<number>, { altitude }: { altitude: boolean }) => {
    setForm((previous) => ({
      ...previous,
      positionFrame: "absolute",
      altitude,
      rows: previous.rows.map((row, axis) => ({
        ...row,
        position: Number(
          ((pose[axis] ?? 0) / (isAngle(axis) ? DEG : 1)).toFixed(isAngle(axis) ? 1 : 3),
        ),
      })) as Six<AxisRow>,
    }));
    setResult([]);
  };

  const sends = (axis: number): string => {
    if ("error" in preview) {
      return "";
    }
    const { message } = preview;
    const mode = message.mode[axis]!;
    const field = fieldFor(mode);
    if (mode === HOLD) {
      return "hold";
    }
    if (field == undefined) {
      return "";
    }
    const scale = field !== "effort" && isAngle(axis) ? DEG : 1;
    const digits = isAngle(axis) && field !== "effort" ? 1 : 2;
    return `${format(message[field][axis]! / scale, digits)} ${unit(axis, mode)}`;
  };

  const notices: { text: string; color: string }[] = [];
  if (!publisher.supported) {
    notices.push({
      text: "This connection cannot publish: connect to foxglove_bridge with Foxglove WebSocket",
      color: t.danger,
    });
  }
  if ("error" in preview && form.rows.some((row) => row.mode !== KEEP)) {
    notices.push({ text: preview.error, color: t.warn });
  }

  const heading = (text: string) => (
    <span key={text} style={{ color: t.muted, fontSize: 10 }}>
      {text}
    </span>
  );

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        boxSizing: "border-box",
        padding: 8,
        color: t.text,
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <StatusBar
          status={status}
          stale={staleSeconds(data.status, now)}
          statusTopic={config.statusTopic}
          t={t}
        />
        <span style={{ flex: 1 }} />
        <ConfirmButton
          t={t}
          confirm="Click again to re-zero"
          onConfirm={() => {
            void resetPose.call().then((failure) => {
              report(failure, "Re-zeroed: x, y and yaw are 0 here");
            });
          }}
          disabled={!resetPose.supported}
          title="Make the current position and heading the origin: x, y and yaw become 0"
        >
          Re-zero
        </ConfirmButton>
        <Button
          t={t}
          variant="danger"
          onClick={() => {
            report(publisher.publish(holdAllSetpoint()), "Hold all sent");
          }}
        >
          Hold all
        </Button>
        <Button
          t={t}
          onClick={() => {
            report(publisher.publish(levelSetpoint()), "Level sent");
          }}
        >
          Level
        </Button>
      </div>

      <Card
        t={t}
        title="Command"
        extra={<span style={{ color: t.muted }}>x and y share a mode</span>}
      >
        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto auto auto auto auto auto auto",
              columnGap: 10,
              rowGap: 5,
              alignItems: "center",
              justifyContent: "start",
            }}
          >
            {["Axis", "Mode", "Value", "Sends", "Target", "Measured", "Controller"].map(heading)}
            {form.rows.map((row, axis) => {
              const field = fieldFor(row.mode);
              const zIsAltitude = axis === Z && form.altitude && row.mode === POSITION;
              return (
                <Fragment key={axis}>
                  <span style={{ whiteSpace: "nowrap" }}>
                    {zIsAltitude ? "altitude" : AXIS_NAMES[axis]}{" "}
                    <span style={{ color: t.muted, fontSize: 10 }}>
                      {zIsAltitude ? "+ up from bottom" : AXIS_HINTS[axis]}
                    </span>
                  </span>
                  <Segmented
                    options={MODES}
                    value={row.mode}
                    onChange={(mode) => {
                      setRow(axis, { mode });
                    }}
                    t={t}
                  />
                  <span
                    style={{
                      whiteSpace: "nowrap",
                      display: "inline-flex",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    <NumberInput
                      value={field ? row[field] : undefined}
                      disabled={field == undefined}
                      onChange={(value) => {
                        if (field) {
                          setRow(axis, { [field]: value ?? NaN });
                        }
                      }}
                      onEnter={send}
                      t={t}
                    />
                    <span style={{ color: t.muted, minWidth: 26 }}>{unit(axis, row.mode)}</span>
                  </span>
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                      color: t.pending,
                    }}
                  >
                    {sends(axis)}
                  </span>
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                      color: t.target,
                    }}
                  >
                    {status?.altitude === true && axis === Z
                      ? `${format(status.target[Z], 2)} m alt`
                      : poseText(axis, status?.target[axis])}
                  </span>
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                      color: t.accent,
                    }}
                  >
                    {poseText(axis, measured?.[axis])}
                  </span>
                  <span style={{ whiteSpace: "nowrap", color: t.muted }}>
                    {modeName(status, axis)}
                  </span>
                </Fragment>
              );
            })}
          </div>
        </div>
      </Card>

      <Card t={t} title="Options">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            columnGap: 10,
            rowGap: 6,
            alignItems: "center",
          }}
        >
          <span>Position targets</span>
          <span>
            <Segmented
              options={POSITION_FRAMES}
              value={form.positionFrame}
              onChange={(positionFrame) => {
                setForm((previous) => ({ ...previous, positionFrame }));
              }}
              t={t}
            />
          </span>
          <span>z position is</span>
          <span>
            <Segmented
              options={[
                { value: "depth", label: "odom z", title: "1 m deep is −1" },
                {
                  value: "altitude",
                  label: "Altitude",
                  title: "Height above the bottom, from the DVL",
                },
              ]}
              value={form.altitude ? "altitude" : "depth"}
              onChange={(value) => {
                setForm((previous) => ({ ...previous, altitude: value === "altitude" }));
              }}
              t={t}
            />
          </span>
          <span>x/y velocity along</span>
          <span>
            <Segmented<VelocityFrame>
              options={[
                { value: HEADING, label: "Heading", title: "x forward and y left along the yaw" },
                { value: WORLD, label: "Odom x/y" },
              ]}
              value={form.velocityFrame}
              onChange={(velocityFrame) => {
                setForm((previous) => ({ ...previous, velocityFrame }));
              }}
              t={t}
            />
          </span>
          <span>Vel/Effort hold after</span>
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <NumberInput
              value={form.timeout}
              onChange={(timeout) => {
                setForm((previous) => ({ ...previous, timeout: timeout ?? NaN }));
              }}
              t={t}
            />
            <span style={{ color: t.muted }}>s (0 latches until replaced)</span>
          </span>
        </div>
      </Card>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button t={t} variant="primary" onClick={send} disabled={"error" in preview}>
          Send
        </Button>
        <Button
          t={t}
          onClick={() => {
            if (status) {
              loadPose(status.target, { altitude: status.altitude });
            }
          }}
          disabled={!status}
          title="Fill the positions with the controller's current target"
        >
          Load target
        </Button>
        <Button
          t={t}
          onClick={() => {
            if (measured) {
              loadPose(measured, { altitude: false });
            }
          }}
          disabled={!measured}
          title="Fill the positions with the measured pose"
        >
          Load measured
        </Button>
        <Button
          t={t}
          onClick={() => {
            setForm((previous) => ({
              ...previous,
              rows: previous.rows.map((row) => ({ ...row, mode: KEEP })) as Six<AxisRow>,
            }));
            setResult([]);
          }}
        >
          All Keep
        </Button>
      </div>

      {[...notices, ...result, ...(acknowledged ? [acknowledged] : [])].map(({ text, color }) => (
        <div key={text} style={{ color }}>
          {text}
        </div>
      ))}

      <div style={{ color: t.muted, lineHeight: 1.5 }}>
        Values are in the frames of the message: odom is ENU, with x, y and yaw zero where the kill
        switch was last released, and roll, pitch and yaw are ZYX Euler angles. Velocity runs along
        the frame chosen for x/y, vertically for z, and as Euler angle rates for rotations; Effort
        pushes along the body axes. Both hold once the timeout runs out.
      </div>
    </div>
  );
}

export function initSetpointPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<SetpointPanel context={context} />);
  return () => {
    root.unmount();
  };
}
