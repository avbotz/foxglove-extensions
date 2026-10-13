// Bounded tuning routines on motion_setpoint (step, cruise, hold, square), the path they trace,
// the controller's state, Hold here and Zero pose. docs/control.md#tuning is the procedure.

import { Immutable, PanelExtensionContext, SettingsTreeNodes, Topic } from "@foxglove/extension";
import { ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { PathPoint, PathView, PathViewKind } from "./PathView";
import { DEFAULT_NODE } from "./gains";
import {
  AxisName,
  ROUTINES,
  ROUTINE_AXES,
  ROUTINE_DEFAULTS,
  ROUTINE_HINTS,
  ROUTINE_RATE,
  Run,
  RoutineForm,
  RoutineKind,
  TRAJECTORY_GROUP,
  holdAt,
  isAxisName,
  isRoutineKind,
  moveTime,
  newRun,
  plan,
  preview,
  problem,
  segmentSetpoint,
  startPose,
  stopSetpoint,
  tick,
} from "./routines";
import {
  AXIS_NAMES,
  DEFAULT_ALTITUDE_TOPIC,
  DEFAULT_ODOMETRY_TOPIC,
  DEFAULT_RESET_SERVICE,
  DEFAULT_SETPOINT_TOPIC,
  DEFAULT_STATUS_TOPIC,
  MotionSetpoint,
  NUM_THRUSTERS,
  PITCH,
  ROLL,
  X,
  Y,
  YAW,
  Z,
  newCommandId,
  odometryPose,
  rangeAltitude,
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
import { getParameters } from "../../common/params";
import {
  Button,
  Card,
  ConfirmButton,
  NumberInput,
  Segmented,
  StatusBar,
  Theme,
  format,
  modeName,
  theme,
} from "../../common/ui";

type Config = {
  topic: string;
  statusTopic: string;
  odometryTopic: string;
  altitudeTopic: string;
  resetService: string;
  node: string;
  form: RoutineForm;
  view: PathViewKind;
};

const DEFAULT_FORM: RoutineForm = { kind: "step", axis: "z", amplitude: 0.5, hold: 10, settle: 5, cycles: 1 };

type RoutineState = {
  status: "idle" | "running" | "complete" | "stopped" | "aborted";
  message: string;
  progress: number;
};

// Trail points closer than this are dropped; a jump longer than this one restarts the trail.
const TRAIL_SPACING = 0.02;
const TRAIL_JUMP = 3;
const TRAIL_POINTS = 3000;
// [ms] between reads of the trajectory limits, for the routine hint.
const LIMITS_REFRESH_MS = 15000;

function loadForm(saved: unknown): RoutineForm {
  const s = record(saved);
  const d = DEFAULT_FORM;
  return {
    kind: isRoutineKind(s.kind) ? s.kind : d.kind,
    axis: isAxisName(s.axis) ? s.axis : d.axis,
    amplitude: numberOr(s.amplitude, d.amplitude),
    hold: numberOr(s.hold, d.hold, 0),
    settle: numberOr(s.settle, d.settle, 0),
    cycles: Math.round(numberOr(s.cycles, d.cycles, 1, 20)),
  };
}

function loadConfig(saved: unknown): Config {
  const s = record(saved);
  return {
    topic: stringOr(s.topic, DEFAULT_SETPOINT_TOPIC),
    statusTopic: stringOr(s.statusTopic, DEFAULT_STATUS_TOPIC),
    odometryTopic: stringOr(s.odometryTopic, DEFAULT_ODOMETRY_TOPIC),
    altitudeTopic: stringOr(s.altitudeTopic, DEFAULT_ALTITUDE_TOPIC),
    resetService: stringOr(s.resetService, DEFAULT_RESET_SERVICE),
    node: stringOr(s.node, DEFAULT_NODE),
    form: loadForm(s.form),
    view: s.view === "xz" || s.view === "yz" ? s.view : "xy",
  };
}

const TEXT_FIELDS = ["topic", "statusTopic", "odometryTopic", "altitudeTopic", "resetService", "node"] as const;

function applySetting(config: Config, path: readonly string[], value: unknown): Config {
  const [, field] = path;
  const textField = TEXT_FIELDS.find((name) => name === field);
  if (textField != undefined) {
    return { ...config, [textField]: typeof value === "string" ? value.trim() : "" };
  }
  return config;
}

function buildSettings(config: Config, topics: Immutable<Topic[]>): SettingsTreeNodes {
  return {
    general: {
      label: "Routines",
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
        altitudeTopic: {
          label: "Altitude topic",
          input: "autocomplete",
          value: config.altitudeTopic,
          items: topicItems(topics, "altitude", config.altitudeTopic),
          help: "sensor_msgs/msg/Range from the DVL",
        },
        resetService: {
          label: "Re-zero service",
          input: "string",
          value: config.resetService,
          help: "std_srvs/srv/Trigger that makes the current position and heading the origin",
        },
        node: {
          label: "Controller node",
          input: "string",
          value: config.node,
          help: "Its trajectory.* limits size the routine hints",
        },
      },
    },
  };
}

function amplitudeLabel(kind: RoutineKind, axis: AxisName): string {
  const unit = axis === "roll" || axis === "pitch" || axis === "yaw" ? "rad" : "m";
  return kind === "step" ? `Step (${unit})` : kind === "cruise" ? `Speed (${unit}/s)` : "Side (m)";
}

function holdLabel(kind: RoutineKind): string {
  return kind === "cruise"
    ? "At speed (s)"
    : kind === "hold"
      ? "Duration (s)"
      : kind === "square"
        ? "Per corner (s)"
        : "Hold (s)";
}

/** The form's defaults for a routine; with `keepTimes`, only the axis and amplitude change. */
function withDefaults(
  form: RoutineForm,
  kind: RoutineKind,
  axis: AxisName,
  { keepTimes }: { keepTimes: boolean },
): RoutineForm {
  const allowed = ROUTINE_AXES[kind];
  const nextAxis = allowed.length === 0 || allowed.includes(axis) ? axis : allowed.includes("z") ? "z" : allowed[0]!;
  const defaults = ROUTINE_DEFAULTS[kind] as Record<string, number>;
  const amplitude = defaults[nextAxis] ?? defaults.amplitude ?? 0;
  if (keepTimes) {
    return { ...form, kind, axis: nextAxis, amplitude };
  }
  return { kind, axis: nextAxis, amplitude, hold: defaults.hold ?? 10, settle: defaults.settle ?? 5, cycles: defaults.cycles ?? 1 };
}

function routineHint(form: RoutineForm, limits: ReadonlyMap<string, readonly number[]>): string {
  const { kind } = form;
  const axis = kind === "square" ? "x" : form.axis;
  const amplitude = Math.abs(form.amplitude);
  const rotation = axis === "roll" || axis === "pitch" || axis === "yaw";
  const unit = rotation ? "rad" : "m";
  let hint = ROUTINE_HINTS[kind];
  const group = `trajectory.${TRAJECTORY_GROUP[axis]}`;
  const limit = limits.get(group);
  if (limit?.length === 3 && kind !== "hold" && amplitude > 0) {
    const [vMax = 0, aMax = 0, jMax = 0] = limit;
    if (kind === "cruise") {
      hint +=
        amplitude > vMax
          ? ` The reference is limited to ${group} v max, ${vMax} ${unit}/s.`
          : ` Up to speed in about ${(amplitude / aMax + aMax / jMax).toFixed(1)} s.`;
    } else {
      hint += ` Each move takes about ${moveTime(amplitude, limit).toFixed(1)} s at ${group}.`;
    }
  }
  if (rotation && kind !== "hold" && amplitude > 0) {
    hint += ` ${amplitude} rad = ${((amplitude * 180) / Math.PI).toFixed(1)}°.`;
  }
  return hint;
}

function RoutinesPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [config, setConfig] = useState(() => loadConfig(context.initialState));
  const data = usePanelData(context, {
    status: config.statusTopic,
    odometry: config.odometryTopic,
    altitude: config.altitudeTopic,
  });
  const t = theme(data.colorScheme);
  const now = useNow(250);
  const nodes = useMemo(() => buildSettings(config, data.topics), [config, data.topics]);
  useSettings(context, config, nodes, applySetting, setConfig);
  const configRef = useRef(config);
  configRef.current = config;
  const dataRef = useRef(data);
  dataRef.current = data;

  const [routineState, setRoutineState] = useState<RoutineState>({ status: "idle", message: "Ready", progress: 0 });
  const [running, setRunning] = useState(false);
  const runRef = useRef<Run | undefined>(undefined);
  const [planned, setPlanned] = useState<PathPoint[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [limits, setLimits] = useState<Map<string, readonly number[]>>(new Map());
  const [measuredTrail, setMeasuredTrail] = useState<PathPoint[]>([]);
  const [referenceTrail, setReferenceTrail] = useState<PathPoint[]>([]);
  const measuredTrailRef = useRef<PathPoint[]>([]);
  const referenceTrailRef = useRef<PathPoint[]>([]);

  const stopMessage = useCallback(() => {
    const run = runRef.current;
    return run ? stopSetpoint(run.routine.start[ROLL], run.routine.start[PITCH], newCommandId()) : undefined;
  }, []);
  const publisher = useSetpointPublisher(context, config.topic, () => {
    const message = stopMessage();
    runRef.current = undefined;
    return message;
  });
  const publishRef = useRef(publisher.publish);
  publishRef.current = publisher.publish;

  const send = useCallback((message: MotionSetpoint): boolean => {
    const failure = publishRef.current(message);
    setError(failure);
    return failure == undefined;
  }, []);

  const finish = useCallback(
    (status: RoutineState["status"], message: string, { hold }: { hold: boolean }) => {
      const run = runRef.current;
      if (!run) {
        return;
      }
      runRef.current = undefined;
      setRunning(false);
      setRoutineState((previous) => ({
        status,
        message,
        progress: status === "complete" ? 1 : previous.progress,
      }));
      if (hold) {
        send(stopSetpoint(run.routine.start[ROLL], run.routine.start[PITCH], newCommandId()));
      }
    },
    [send],
  );

  // The runner.
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = setInterval(() => {
      const run = runRef.current;
      if (!run) {
        return;
      }
      const time = Date.now();
      const status = fresh(dataRef.current.status, time);
      const action = tick(run, time, status, fresh(dataRef.current.odometry, time));
      if (action.kind === "finish") {
        finish(action.status, action.message, { hold: action.hold });
        return;
      }
      const progress = Math.min(1, (time - run.startedAt) / 1000 / run.routine.duration);
      if (action.kind === "send") {
        if (!send(action.message)) {
          finish("aborted", "Publishing failed", { hold: false });
          return;
        }
        setRoutineState({ status: "running", message: action.label, progress });
      } else {
        setRoutineState((previous) => ({ ...previous, progress }));
      }
    }, 1000 / ROUTINE_RATE);
    return () => {
      clearInterval(id);
    };
  }, [running, finish, send]);

  const start = () => {
    const time = Date.now();
    const status = fresh(dataRef.current.status, time);
    const odometry = fresh(dataRef.current.odometry, time);
    const issue = problem(status, odometry);
    if (issue != undefined || !status || !odometry) {
      setError(issue ?? "No telemetry");
      return;
    }
    const routine = plan(configRef.current.form, startPose(status, odometryPose(odometry)));
    if ("error" in routine) {
      setError(routine.error);
      return;
    }
    // Hold every axis where it is first, so the routine moves only what it tests.
    const run = newRun(routine, time);
    const id = newCommandId();
    run.ids.add(id);
    if (!send(segmentSetpoint(holdAt(routine.start), 0, id))) {
      return;
    }
    runRef.current = run;
    setPlanned(preview(routine));
    setRoutineState({ status: "running", message: "Starting", progress: 0 });
    setRunning(true);
    setError(undefined);
  };

  const holdHere = () => {
    if (runRef.current) {
      finish("stopped", "Stopped: holding here, level", { hold: true });
    } else {
      send(stopSetpoint(0, 0, newCommandId()));
      setInfo("Hold here sent: every axis stops smoothly and holds, level");
    }
  };

  const resetPose = useResetPose(context, config.resetService);
  const reZero = async () => {
    if (runRef.current) {
      setError("Stop the routine first");
      return;
    }
    const failure = await resetPose.call();
    setError(failure);
    if (failure == undefined) {
      measuredTrailRef.current = [];
      referenceTrailRef.current = [];
      setMeasuredTrail([]);
      setReferenceTrail([]);
      setPlanned([]);
      setInfo("Re-zeroed: x, y and yaw are 0 here, and the vehicle holds");
    }
  };

  // The trajectory limits, for the hint.
  const { node } = config;
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      if (node === "") {
        return;
      }
      try {
        const names = ["horizontal", "vertical", "roll", "pitch", "yaw"].map((g) => `trajectory.${g}`);
        const values = await getParameters(context, node, names);
        if (!cancelled) {
          setLimits(
            new Map(
              [...values].map(([name, param]) => [name, Array.isArray(param.value) ? (param.value as number[]) : []]),
            ),
          );
        }
      } catch {
        // No hint without them.
      }
    };
    void read();
    const id = setInterval(() => {
      void read();
    }, LIMITS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [context, node]);

  // The trails.
  const status = fresh(data.status, now);
  const odometry = fresh(data.odometry, now);
  const measured = useMemo(() => (odometry ? odometryPose(odometry) : undefined), [odometry]);
  const altitude = data.altitude ? rangeAltitude(fresh(data.altitude, now) ?? data.altitude.message) : undefined;
  useEffect(() => {
    if (!measured) {
      return;
    }
    const point: PathPoint = [measured[X], measured[Y], measured[Z]];
    const trail = measuredTrailRef.current;
    const last = trail[trail.length - 1];
    const distance = last ? Math.hypot(point[0] - last[0], point[1] - last[1], point[2] - last[2]) : Infinity;
    if (last && distance < TRAIL_SPACING) {
      return;
    }
    const kept = last && distance > TRAIL_JUMP ? [] : trail.slice(-TRAIL_POINTS + 1);
    measuredTrailRef.current = [...kept, point];
    setMeasuredTrail(measuredTrailRef.current);
    if (distance > TRAIL_JUMP) {
      referenceTrailRef.current = [];
      setReferenceTrail([]);
    }
  }, [measured]);
  useEffect(() => {
    if (!status || !measured) {
      return;
    }
    const reference = status.reference_position;
    // A z reference in altitude coordinates is not an odom z: draw it at the measured depth.
    const point: PathPoint = [reference[X]!, reference[Y]!, status.altitude ? measured[Z] : reference[Z]!];
    const trail = referenceTrailRef.current;
    const last = trail[trail.length - 1];
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1], point[2] - last[2]) < TRAIL_SPACING) {
      return;
    }
    referenceTrailRef.current = [...trail.slice(-TRAIL_POINTS + 1), point];
    setReferenceTrail(referenceTrailRef.current);
  }, [status, measured]);

  const { form } = config;
  const setForm = (next: RoutineForm) => {
    setConfig((previous) => ({ ...previous, form: next }));
  };
  const axes = ROUTINE_AXES[form.kind];
  const notices: { text: string; color: string }[] = [];
  if (!publisher.supported) {
    notices.push({
      text: "This connection cannot publish: connect to foxglove_bridge with Foxglove WebSocket",
      color: t.danger,
    });
  }
  const issue = running ? undefined : problem(status, odometry);
  if (issue != undefined) {
    notices.push({ text: `Routines cannot start: ${issue}`, color: t.warn });
  }
  if (error != undefined) {
    notices.push({ text: error, color: t.danger });
  }
  if (info != undefined) {
    notices.push({ text: info, color: t.ok });
  }
  const stateColor = {
    idle: t.muted,
    running: t.accent,
    complete: t.ok,
    stopped: t.warn,
    aborted: t.danger,
  }[routineState.status];
  const health = status ? Array.from(status.thruster_health, (h) => format(h, 1)) : [];
  const saturated = status
    ? Array.from(status.thruster_saturated).flatMap((s, i) => (s ? [i] : []))
    : [];

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
        <StatusBar status={status} stale={staleSeconds(data.status, now)} statusTopic={config.statusTopic} t={t} />
        <span style={{ flex: 1 }} />
        <ConfirmButton
          t={t}
          confirm="Click again to re-zero"
          onConfirm={() => {
            void reZero();
          }}
          disabled={!resetPose.supported || running}
          title="sub_control's reset_pose: the current position and heading become the odom origin"
        >
          Zero pose
        </ConfirmButton>
        <Button
          t={t}
          variant="danger"
          onClick={holdHere}
          title="Stop any routine; every axis stops smoothly and holds where it stops, level"
        >
          Hold here
        </Button>
      </div>
      {notices.map(({ text, color }) => (
        <div key={text} style={{ color }}>
          {text}
        </div>
      ))}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 8 }}>
        <Card
          t={t}
          title="Routine"
          extra={<span style={{ color: stateColor }}>{routineState.status === "idle" ? "Idle" : routineState.message}</span>}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Segmented
              options={ROUTINES.map((kind) => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) }))}
              value={form.kind}
              onChange={(kind) => {
                setForm(withDefaults(form, kind, form.axis, { keepTimes: false }));
              }}
              t={t}
            />
            {axes.length > 0 && (
              <Segmented
                options={axes.map((axis) => ({ value: axis, label: axis }))}
                value={form.axis}
                onChange={(axis) => {
                  setForm(withDefaults(form, form.kind, axis, { keepTimes: true }));
                }}
                t={t}
              />
            )}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {form.kind !== "hold" && (
              <Field label={amplitudeLabel(form.kind, form.axis)} t={t}>
                <NumberInput
                  value={form.amplitude}
                  digits={3}
                  width={56}
                  onChange={(value) => {
                    setForm({ ...form, amplitude: value ?? NaN });
                  }}
                  t={t}
                />
              </Field>
            )}
            <Field label={holdLabel(form.kind)} t={t}>
              <NumberInput
                value={form.hold}
                digits={1}
                width={48}
                onChange={(value) => {
                  setForm({ ...form, hold: value ?? NaN });
                }}
                t={t}
              />
            </Field>
            {form.kind === "cruise" && (
              <Field label="Settle (s)" t={t}>
                <NumberInput
                  value={form.settle}
                  digits={1}
                  width={48}
                  onChange={(value) => {
                    setForm({ ...form, settle: value ?? NaN });
                  }}
                  t={t}
                />
              </Field>
            )}
            {form.kind !== "hold" && (
              <Field label="Cycles" t={t}>
                <NumberInput
                  value={form.cycles}
                  digits={0}
                  width={40}
                  onChange={(value) => {
                    setForm({ ...form, cycles: Math.round(value ?? NaN) });
                  }}
                  t={t}
                />
              </Field>
            )}
          </div>
          <div style={{ color: t.muted, lineHeight: 1.5 }}>{routineHint(form, limits)}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Button t={t} variant="primary" onClick={start} disabled={running || !publisher.supported} title="Start the routine from where the controller is holding">
              Start
            </Button>
            <Button
              t={t}
              variant="danger"
              onClick={() => {
                finish("stopped", "Stopped: holding, level", { hold: true });
              }}
              disabled={!running}
              title="Stop the routine; every axis stops smoothly and holds, level"
            >
              Stop
            </Button>
            <div style={{ flex: 1, height: 6, background: t.surfaceStrong, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${Math.round(routineState.progress * 100)}%`, height: "100%", background: stateColor }} />
            </div>
          </div>
          <div style={{ color: t.muted }}>
            Routines start from where sub_control is holding and move along odom axes; Stop, an abort,
            or closing the panel leaves every axis holding, level. Use the Motion Setpoint panel for
            one command at a time.
          </div>
        </Card>

        <Card
          t={t}
          title="Path"
          extra={
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <Segmented
                options={[
                  { value: "xy", label: "XY", title: "From above" },
                  { value: "xz", label: "XZ", title: "From the side" },
                  { value: "yz", label: "YZ", title: "From the front" },
                ]}
                value={config.view}
                onChange={(view) => {
                  setConfig((previous) => ({ ...previous, view }));
                }}
                t={t}
              />
              <Button
                t={t}
                onClick={() => {
                  measuredTrailRef.current = [];
                  referenceTrailRef.current = [];
                  setMeasuredTrail([]);
                  setReferenceTrail([]);
                  setPlanned([]);
                }}
              >
                Clear
              </Button>
            </span>
          }
        >
          <PathView
            view={config.view}
            measured={measuredTrail}
            reference={referenceTrail}
            planned={planned}
            pose={measured ? { point: [measured[X], measured[Y], measured[Z]], yaw: measured[YAW] } : undefined}
            t={t}
          />
          <div style={{ display: "flex", gap: 12, color: t.muted }}>
            <span style={{ color: t.pending }}>— routine</span>
            <span style={{ color: t.target }}>— reference</span>
            <span style={{ color: t.accent }}>— measured</span>
          </div>
        </Card>
      </div>

      <Card t={t} title="Controller">
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 4 }}>
          <span style={{ color: t.muted }}>Modes</span>
          <span>
            {AXIS_NAMES.map((axis, index) => (
              <span key={axis} style={{ marginRight: 10, whiteSpace: "nowrap" }}>
                {axis} <span style={{ color: t.target }}>{modeName(status, index)}</span>
              </span>
            ))}
          </span>
          <span style={{ color: t.muted }}>Thrusters</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {status
              ? `health ${health.join(" ")} · saturated ${saturated.length > 0 ? saturated.join(", ") : "none"} · ${NUM_THRUSTERS - Array.from(status.thruster_health).filter((h) => h > 0).length} failed`
              : "—"}
          </span>
          <span style={{ color: t.muted }}>Measured</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {measured
              ? `x ${format(measured[X], 2)} y ${format(measured[Y], 2)} z ${format(measured[Z], 2)} m · roll ${format((measured[ROLL] * 180) / Math.PI, 1)}° pitch ${format((measured[PITCH] * 180) / Math.PI, 1)}° yaw ${format((measured[YAW] * 180) / Math.PI, 1)}°` +
                (altitude != undefined ? ` · altitude ${format(altitude, 2)} m` : "")
              : "—"}
          </span>
          <span style={{ color: t.muted }}>State age</span>
          <span>{status ? `${format(status.state_age, 3)} s` : "—"}</span>
        </div>
      </Card>
    </div>
  );
}

function Field({ label, children, t }: { label: string; children: ReactElement; t: Theme }): ReactElement {
  return (
    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <span style={{ color: t.muted }}>{label}</span>
      {children}
    </label>
  );
}

export function initRoutinesPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<RoutinesPanel context={context} />);
  return () => {
    root.unmount();
  };
}
