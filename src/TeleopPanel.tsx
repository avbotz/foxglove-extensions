// The pilot console: instruments that show and set position, heading, depth and attitude
// targets, and 6-DOF manual control from the keyboard and a gamepad. Everything goes out as
// MotionSetpoint, so each axis is commanded on its own.

import { PanelExtensionContext } from "@foxglove/extension";
import {
  FocusEvent,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

import { CommandCard, SpeedControls } from "./CommandCard";
import {
  fresh,
  staleSeconds,
  useNow,
  usePanelData,
  useResetPose,
  useSetpointPublisher,
  useSettings,
} from "./common";
import { Cruise, commandTargets, cruiseStep, withoutAxes } from "./cruise";
import { AttitudeIndicator, Compass, DepthGauge, MapView } from "./instruments";
import {
  DEG,
  EFFORT,
  HEADING,
  HOLD,
  KEEP,
  MotionSetpoint,
  PITCH,
  POSITION,
  ROLL,
  Six,
  VELOCITY,
  WORLD,
  X,
  Y,
  YAW,
  Z,
  emptySetpoint,
  holdAllSetpoint,
  odometryPose,
  rangeAltitude,
} from "./msgs";
import {
  PILOT_LABELS,
  Targets,
  hasTargets,
  noTargets,
  positionSetpoint,
  stepTargets,
  toPilot,
} from "./targets";
import {
  DOFS,
  GAMEPAD_HOLD_BUTTON,
  GAMEPAD_LEVEL_BUTTON,
  GAMEPAD_SOURCES,
  HOLD_KEY,
  KEY_BINDINGS,
  KeyBinding,
  LEVEL_KEY,
  ManualMode,
  NOT_STREAMING,
  OPERATOR_TO_FLU,
  buttonPressed,
  gamepadInput,
  keyboardInput,
  releaseStep,
  stepEdges,
  teleopStep,
  zeros,
} from "./teleop";
import {
  CommandMode,
  TeleopConfig,
  applyTeleopSetting,
  buildTeleopSettings,
  limited,
  loadTeleopConfig,
  stepSizes,
  teleopSettings,
  withAxisMode,
  withManual,
} from "./teleopConfig";
import {
  Bar,
  Button,
  Card,
  ConfirmButton,
  Segmented,
  StatusBar,
  Theme,
  format,
  modeName,
  theme,
} from "./ui";

// A position target this panel sent stands in for the controller's until its status has caught
// up, so quick steps add up instead of each starting from the same place.
const COMMANDED_MS = 500;
// Trail points closer than this are dropped; a jump longer than this one restarts it.
const TRAIL_SPACING = 0.03;
const TRAIL_JUMP = 3;
const TRAIL_POINTS = 2000;

const MANUAL_OPTIONS: { value: ManualMode; label: string; title: string }[] = [
  { value: "rate", label: "Rate", title: "Velocity while held; holds when let go" },
  { value: "step", label: "Step", title: "One position step per press" },
  { value: "lock", label: "Lock", title: "Ignore input on this axis" },
];

const KEY_BY_CODE = new Map(KEY_BINDINGS.map((binding) => [binding.code, binding]));

/** The keys for an axis, positive direction first, e.g. "W/S". */
function keysFor(dof: number): string {
  const positive = KEY_BINDINGS.find((b) => b.dof === dof && b.sign > 0)?.label ?? "";
  const negative = KEY_BINDINGS.find((b) => b.dof === dof && b.sign < 0)?.label ?? "";
  return `${positive}/${negative}`;
}

function keyHint({ dof, sign }: KeyBinding): string {
  const { label, positive, negative } = DOFS[dof]!;
  const direction = sign > 0 ? positive : negative;
  return dof === ROLL || dof === YAW ? `${label.toLowerCase()} ${direction}` : direction;
}

const KEY_ROWS: (string | undefined)[][][] = [
  [
    ["KeyQ", "KeyW", "KeyE", "KeyR"],
    ["KeyA", "KeyS", "KeyD", "KeyF"],
  ],
  [
    [undefined, "KeyI", undefined],
    ["KeyJ", "KeyK", "KeyL"],
  ],
];

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
    return true;
  }
  return (
    target instanceof HTMLInputElement &&
    !["range", "checkbox", "radio", "button"].includes(target.type)
  );
}

function pickGamepad(): Gamepad | undefined {
  try {
    const pads = Array.from(navigator.getGamepads()).filter(
      (pad): pad is Gamepad => pad?.connected === true,
    );
    return pads.find((pad) => pad.mapping === "standard") ?? pads[0];
  } catch {
    return undefined;
  }
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function pilotText(axis: number, value: number): string {
  const { unit } = PILOT_LABELS[axis]!;
  return `${format(toPilot(axis, value), axis >= ROLL ? 1 : 2)}${unit === "°" ? "°" : ` ${unit}`}`;
}

/** The last command each axis was sent, in operator directions and display units. */
function describeSent(previous: Six<string>, message: MotionSetpoint): Six<string> {
  return previous.map((text, axis) => {
    const angle = axis >= ROLL;
    const sign = OPERATOR_TO_FLU[axis]!;
    switch (message.mode[axis]) {
      case KEEP:
      case undefined:
        return text;
      case VELOCITY: {
        const value = (sign * message.velocity[axis]!) / (angle ? DEG : 1);
        return angle ? `${format(value, 0)} °/s` : `${format(value, 2)} m/s`;
      }
      case EFFORT: {
        const value = sign * message.effort[axis]!;
        return angle ? `${format(value, 1)} N·m` : `${format(value, 1)} N`;
      }
      case HOLD:
        return "hold";
      case POSITION:
        return `→ ${pilotText(axis, message.position[axis]!)}`;
    }
    return text;
  }) as Six<string>;
}

function Key({
  code,
  pressed,
  t,
}: {
  code: string | undefined;
  pressed: boolean;
  t: Theme;
}): ReactElement {
  const binding = code ? KEY_BY_CODE.get(code) : undefined;
  if (!binding) {
    return <div />;
  }
  return (
    <div
      style={{
        border: `1px solid ${pressed ? t.accent : t.border}`,
        background: pressed ? t.accentSoft : t.surfaceStrong,
        borderRadius: 4,
        padding: "2px 0",
        textAlign: "center",
        lineHeight: 1.15,
      }}
    >
      <div style={{ fontWeight: 700 }}>{binding.label}</div>
      <div style={{ fontSize: 9, color: t.muted, whiteSpace: "nowrap" }}>{keyHint(binding)}</div>
    </div>
  );
}

function Readout({
  measured,
  target,
  t,
}: {
  measured: string;
  target?: string;
  t: Theme;
}): ReactElement {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: t.accent, fontWeight: 600 }}>{measured}</span>
      {target != undefined && <span style={{ color: t.target }}> → {target}</span>}
    </span>
  );
}

function Row({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </div>
  );
}

function TeleopPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [config, setConfig] = useState(() => loadTeleopConfig(context.initialState));
  const data = usePanelData(context, {
    status: config.statusTopic,
    odometry: config.odometryTopic,
    altitude: config.altitudeTopic,
  });
  const t = theme(data.colorScheme);
  const now = useNow(250);

  const nodes = useMemo(() => buildTeleopSettings(config, data.topics), [config, data.topics]);
  useSettings(context, config, nodes, applyTeleopSetting, setConfig);
  const settings = useMemo(() => teleopSettings(config), [config]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const configRef = useRef(config);
  configRef.current = config;

  // What the instruments show.
  const status = fresh(data.status, now);
  const odometry = fresh(data.odometry, now);
  const measured = useMemo(() => (odometry ? odometryPose(odometry) : undefined), [odometry]);
  const rangeMessage = fresh(data.altitude, now);
  const altitude = rangeMessage ? rangeAltitude(rangeMessage) : undefined;
  const statusRef = useRef(status);
  statusRef.current = status;
  const measuredRef = useRef(measured);
  measuredRef.current = measured;
  /** The controller's target on an axis, if it has one to show. */
  const controllerTarget = (axis: number): number | undefined =>
    status && !(axis === Z && status.altitude) ? status.target[axis] : undefined;

  // Pending targets, picked on the instruments or typed, sent with Go.
  const [pending, setPending] = useState<Targets>(noTargets);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const commandedRef = useRef<({ value: number; time: number } | undefined)[]>([]);
  // Pending velocities [odom signs], and the velocities the panel keeps streaming.
  const [pendingVelocity, setPendingVelocity] = useState<Targets>(noTargets);
  const pendingVelocityRef = useRef(pendingVelocity);
  pendingVelocityRef.current = pendingVelocity;
  const [cruise, setCruise] = useState<Cruise | undefined>();
  const cruiseRef = useRef<Cruise | undefined>(undefined);
  const updateCruise = useCallback((next: Cruise | undefined) => {
    cruiseRef.current = next;
    setCruise(next);
  }, []);

  // The track on the map, restarted when the pose jumps.
  const [trail, setTrail] = useState<(readonly [number, number])[]>([]);
  const trailRef = useRef<(readonly [number, number])[]>([]);

  // Manual control.
  const streamingRef = useRef<Six<boolean>>(NOT_STREAMING);
  // Set by Hold all (and on enabling the gamepad or refocusing the window): rate input is
  // ignored until every input is back at neutral, so a held key or deflected stick cannot
  // drive straight on.
  const stoppedRef = useRef(false);
  const armedRef = useRef<Six<boolean>>([true, true, true, true, true, true]);
  const pressedRef = useRef(new Set<string>());
  const [pressed, setPressed] = useState<ReadonlySet<string>>(() => new Set());
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [typing, setTyping] = useState(false);
  const [gamepadOn, setGamepadOn] = useState(false);
  const gamepadOnRef = useRef(false);
  gamepadOnRef.current = gamepadOn;
  const [gamepad, setGamepad] = useState<{ id: string; standard: boolean } | undefined>();
  const windowFocusedRef = useRef(document.hasFocus());
  const [windowFocused, setWindowFocused] = useState(windowFocusedRef.current);
  const buttonsRef = useRef({ hold: false, level: false });
  const [input, setInput] = useState<Six<number>>(zeros);
  const [stopped, setStopped] = useState(false);
  const [sent, setSent] = useState<Six<string>>(["—", "—", "—", "—", "—", "—"]);
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<{ text: string; until: number } | undefined>();

  const publisher = useSetpointPublisher(context, config.topic, () => {
    const step = releaseStep(streamingRef.current, settingsRef.current);
    streamingRef.current = NOT_STREAMING;
    return step.message;
  });
  const publishRef = useRef(publisher.publish);
  publishRef.current = publisher.publish;

  const send = useCallback((message: MotionSetpoint): boolean => {
    const failure = publishRef.current(message);
    setError(failure);
    if (failure != undefined) {
      return false;
    }
    setSent((previous) => describeSent(previous, message));
    const time = Date.now();
    message.mode.forEach((mode, axis) => {
      if (mode === POSITION) {
        commandedRef.current[axis] = { value: message.position[axis]!, time };
      } else if (mode !== KEEP) {
        commandedRef.current[axis] = undefined;
      }
    });
    // Anything but a velocity ends the cruise on that axis.
    const ended = [0, 1, 2, 3, 4, 5].filter(
      (axis) => message.mode[axis] !== KEEP && message.mode[axis] !== VELOCITY,
    );
    if (cruiseRef.current && ended.length > 0) {
      cruiseRef.current = withoutAxes(cruiseRef.current, ended);
      setCruise(cruiseRef.current);
    }
    return true;
  }, []);

  /** Where steps start from: the latest target on each axis, else the measured pose. */
  const currentBase = useCallback((): Six<number> | undefined => {
    const time = Date.now();
    const latestStatus = statusRef.current;
    const latestPose = measuredRef.current;
    if (!latestStatus && !latestPose) {
      return undefined;
    }
    return [0, 1, 2, 3, 4, 5].map((axis) => {
      const local = commandedRef.current[axis];
      if (local && time - local.time < COMMANDED_MS) {
        return local.value;
      }
      if (latestStatus && !(axis === Z && latestStatus.altitude)) {
        return latestStatus.target[axis] ?? NaN;
      }
      return latestPose?.[axis] ?? NaN;
    }) as Six<number>;
  }, []);

  const sendTargets = useCallback(
    (targets: Targets): boolean => {
      const built = positionSetpoint(targets, currentBase());
      if ("error" in built) {
        setError(built.error);
        return false;
      }
      return send(built.message);
    },
    [currentBase, send],
  );

  /** Steps by `counts` (operator directions) from the current targets. */
  const stepBy = useCallback(
    (counts: readonly number[], sizes: Six<number> = stepSizes(configRef.current)) => {
      const base = currentBase();
      if (!base) {
        setError("Nothing to step from yet: waiting for control/status or odometry");
        return;
      }
      sendTargets(stepTargets(counts, base, sizes));
    },
    [currentBase, sendTargets],
  );

  const stepAxis = (axis: number, direction: number, size?: number) => {
    const counts = zeros();
    counts[axis] = direction;
    const sizes = stepSizes(configRef.current);
    if (size != undefined) {
      sizes[axis] = size;
    }
    stepBy(counts, sizes);
  };

  const holdAll = useCallback(() => {
    streamingRef.current = NOT_STREAMING;
    stoppedRef.current = true;
    setStopped(true);
    send(holdAllSetpoint());
  }, [send]);

  const level = useCallback(() => {
    sendTargets([undefined, undefined, undefined, 0, 0, undefined]);
  }, [sendTargets]);

  // Pending targets live in a ref too, so a key pressed right after a click sees the click.
  const updatePending = useCallback((next: Targets) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const updatePendingVelocity = useCallback((next: Targets) => {
    pendingVelocityRef.current = next;
    setPendingVelocity(next);
  }, []);

  const clearPending = useCallback(() => {
    updatePending(noTargets());
    updatePendingVelocity(noTargets());
  }, [updatePending, updatePendingVelocity]);

  /** Sends what the Command card has pending: positions now, velocities as a new cruise. */
  const go = useCallback(() => {
    const { commandModes, cruiseSeconds, cruiseFrame } = configRef.current;
    const pick = (values: Targets, mode: CommandMode) =>
      values.map((value, axis) => (commandModes[axis] === mode ? value : undefined)) as Targets;
    const positions = pick(pendingRef.current, "position");
    const velocities = pick(pendingVelocityRef.current, "velocity");
    if (!hasTargets(positions) && !hasTargets(velocities)) {
      return;
    }
    const built = commandTargets(positions, velocities, currentBase());
    if ("error" in built) {
      setError(built.error);
      return;
    }
    if (built.positions && !send(built.positions)) {
      return;
    }
    if (hasTargets(built.velocity)) {
      const velocity = (cruiseRef.current?.velocity.slice() ?? noTargets()) as Targets;
      built.velocity.forEach((value, axis) => {
        if (value != undefined) {
          velocity[axis] = value;
        }
      });
      const started = Date.now();
      const next: Cruise = {
        velocity,
        frame: cruiseFrame === "world" ? WORLD : HEADING,
        until: cruiseSeconds > 0 ? started + cruiseSeconds * 1000 : undefined,
      };
      // Send it now rather than at the next cycle.
      const first = cruiseStep(undefined, next, started, settingsRef.current.timeout);
      updateCruise(first.cruise);
      if (first.message && !send(first.message)) {
        return;
      }
    }
    clearPending();
  }, [clearPending, currentBase, send, updateCruise]);

  const stopCruise = useCallback(() => {
    const current = cruiseRef.current;
    if (!current) {
      return;
    }
    const message = emptySetpoint();
    current.velocity.forEach((value, axis) => {
      if (value != undefined) {
        message.mode[axis] = HOLD;
      }
    });
    updateCruise(undefined);
    send(message);
  }, [send, updateCruise]);

  const setCommandMode = (axis: number, mode: CommandMode) => {
    const current = configRef.current;
    if (current.commandModes[axis] === mode) {
      return;
    }
    const next: TeleopConfig = {
      ...current,
      commandModes: withAxisMode(current.commandModes, axis, mode),
    };
    configRef.current = next;
    setConfig(next);
  };

  /** Pending position targets, from the instruments or the Command card. */
  const setPendingAxes = (values: Partial<Record<number, number | undefined>>) => {
    const next = pendingRef.current.slice() as Targets;
    for (const [key, value] of Object.entries(values)) {
      const axis = Number(key);
      next[axis] = value;
      if (value != undefined) {
        setCommandMode(axis, "position");
      }
    }
    updatePending(next);
  };

  const setPendingVelocityAxis = (axis: number, value: number | undefined) => {
    const next = pendingVelocityRef.current.slice() as Targets;
    next[axis] = value;
    updatePendingVelocity(next);
  };

  const resetPose = useResetPose(context, config.resetService);
  const reZero = useCallback(async () => {
    const failure = await resetPose.call();
    setError(failure);
    if (failure != undefined) {
      return;
    }
    // Everything the panel holds in the old frame goes.
    updateCruise(undefined);
    clearPending();
    commandedRef.current = [];
    trailRef.current = [];
    setTrail([]);
    setInfo({
      text: "Re-zeroed: x, y and yaw are 0 here, and the vehicle holds",
      until: Date.now() + 6000,
    });
  }, [clearPending, resetPose, updateCruise]);

  const releaseKeys = useCallback(() => {
    if (pressedRef.current.size > 0) {
      pressedRef.current = new Set();
      setPressed(pressedRef.current);
    }
  }, []);

  // The publishing cycle.
  useEffect(() => {
    const id = setInterval(() => {
      const raw = keyboardInput(pressedRef.current);
      const pad = gamepadOnRef.current && windowFocusedRef.current ? pickGamepad() : undefined;
      let padInput = zeros();
      if (pad) {
        const { deadzone, gamepad: mapping } = configRef.current;
        padInput = gamepadInput(pad, mapping, deadzone);
        const hold = buttonPressed(pad, GAMEPAD_HOLD_BUTTON);
        const levelPressed = buttonPressed(pad, GAMEPAD_LEVEL_BUTTON);
        if (hold && !buttonsRef.current.hold) {
          holdAll();
        }
        if (levelPressed && !buttonsRef.current.level) {
          level();
        }
        buttonsRef.current = { hold, level: levelPressed };
      }
      setGamepad(pad ? { id: pad.id, standard: pad.mapping === "standard" } : undefined);

      // Sticks and triggers on step axes step once per push.
      const edges = stepEdges(padInput, armedRef.current, configRef.current.manual);
      armedRef.current = edges.armed;
      if (edges.counts.some((count) => count !== 0)) {
        stepBy(edges.counts);
      }

      const combined = raw.map((value, dof) => clampUnit(value + padInput[dof]!)) as Six<number>;
      if (stoppedRef.current && combined.every((value) => value === 0)) {
        stoppedRef.current = false;
      }
      const command = stoppedRef.current ? zeros() : combined;
      const step = teleopStep(command, streamingRef.current, settingsRef.current);
      streamingRef.current = step.streaming;
      const cruised = cruiseStep(
        step.message,
        cruiseRef.current,
        Date.now(),
        settingsRef.current.timeout,
      );
      if (cruised.cruise !== cruiseRef.current) {
        updateCruise(cruised.cruise);
      }
      if (cruised.message) {
        send(cruised.message);
      }
      setInput(combined);
      setStopped(stoppedRef.current);
    }, 1000 / config.rate);
    return () => {
      clearInterval(id);
    };
  }, [config.rate, holdAll, level, send, stepBy, updateCruise]);

  // Leaving the window lets go of every key and pauses the gamepad, whose state the browser
  // stops updating; coming back waits for neutral before driving again.
  useEffect(() => {
    const leave = () => {
      windowFocusedRef.current = false;
      setWindowFocused(false);
      releaseKeys();
    };
    const enter = () => {
      windowFocusedRef.current = true;
      setWindowFocused(true);
      stoppedRef.current = true;
    };
    const visibility = () => {
      if (document.hidden) {
        leave();
      }
    };
    window.addEventListener("blur", leave);
    window.addEventListener("focus", enter);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", enter);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [releaseKeys]);

  // The track on the map, restarted when the pose jumps (the EKF resets x, y and yaw to zero
  // whenever the vehicle is unkilled).
  useEffect(() => {
    if (!measured) {
      return;
    }
    const point = [measured[X], measured[Y]] as const;
    const last = trailRef.current[trailRef.current.length - 1];
    const distance = last ? Math.hypot(point[0] - last[0], point[1] - last[1]) : Infinity;
    if (last && distance < TRAIL_SPACING) {
      return;
    }
    const kept = last && distance > TRAIL_JUMP ? [] : trailRef.current.slice(-TRAIL_POINTS + 1);
    trailRef.current = [...kept, point];
    setTrail(trailRef.current);
  }, [measured]);

  const toggleGamepad = () => {
    if (!gamepadOn) {
      stoppedRef.current = true;
      armedRef.current = [false, false, false, false, false, false];
      const pad = pickGamepad();
      buttonsRef.current = {
        hold: pad != undefined && buttonPressed(pad, GAMEPAD_HOLD_BUTTON),
        level: pad != undefined && buttonPressed(pad, GAMEPAD_LEVEL_BUTTON),
      };
    }
    setGamepadOn(!gamepadOn);
  };

  const setManual = (axis: number, mode: ManualMode) => {
    const next = { ...configRef.current, manual: withManual(configRef.current.manual, axis, mode) };
    configRef.current = next;
    setConfig(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || isTextEntry(event.target)) {
      return;
    }
    const binding = KEY_BY_CODE.get(event.code);
    const actions: Record<string, (() => void) | undefined> = {
      [HOLD_KEY]: holdAll,
      [LEVEL_KEY]: level,
      Enter: go,
      Escape: clearPending,
    };
    const action = actions[event.code];
    if (action == undefined && binding == undefined) {
      return;
    }
    // Keep the key from Foxglove's own shortcuts and from scrolling the panel.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) {
      return;
    }
    if (action) {
      action();
      return;
    }
    if (binding == undefined || configRef.current.manual[binding.dof] === "lock") {
      return;
    }
    if (!pressedRef.current.has(binding.code)) {
      pressedRef.current = new Set(pressedRef.current).add(binding.code);
      setPressed(pressedRef.current);
    }
    if (configRef.current.manual[binding.dof] === "step") {
      stepAxis(binding.dof, binding.sign);
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (KEY_BY_CODE.has(event.code)) {
      event.stopPropagation();
      const next = new Set(pressedRef.current);
      next.delete(event.code);
      pressedRef.current = next;
      setPressed(next);
    }
  };

  const onFocus = (event: FocusEvent) => {
    setKeyboardActive(true);
    const entry = isTextEntry(event.target);
    setTyping(entry);
    if (entry) {
      releaseKeys();
    }
  };

  const onBlur = (event: FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setKeyboardActive(false);
      setTyping(false);
      releaseKeys();
    }
  };

  // --- Display ---

  const notices: { text: string; color: string }[] = [];
  const profile = context.dataSourceProfile;
  if (!publisher.supported) {
    notices.push({
      text: "This connection cannot publish: connect to foxglove_bridge with Foxglove WebSocket",
      color: t.danger,
    });
  } else if (profile != undefined && profile !== "ros2") {
    notices.push({
      text: `Connected to a ${profile} source; MotionSetpoint is a ROS 2 message`,
      color: t.warn,
    });
  }
  if (error) {
    notices.push({ text: error, color: t.danger });
  }
  if (info && now < info.until) {
    notices.push({ text: info.text, color: t.ok });
  }
  if (config.command === "effort") {
    notices.push({
      text: "Rate axes push open loop (Effort), with no feedback",
      color: t.warn,
    });
  }
  if (stopped) {
    notices.push({ text: "Stopped: let go of every control to drive again", color: t.warn });
  }
  if (gamepadOn && gamepad && !gamepad.standard) {
    notices.push({
      text: "This gamepad has no standard mapping, so its sticks may not match the settings",
      color: t.warn,
    });
  }

  const yawTarget = controllerTarget(YAW);
  const depth = measured ? -measured[Z] : undefined;
  const depthTarget = controllerTarget(Z);
  const steps = config.steps;
  const xyTarget =
    status?.mode[X] === POSITION ? { x: status.target[X]!, y: status.target[Y]! } : undefined;
  const toGo =
    measured && xyTarget
      ? Math.hypot(xyTarget.x - measured[X], xyTarget.y - measured[Y])
      : undefined;

  const keyboardLabel = typing
    ? "Typing: drive keys paused"
    : keyboardActive
      ? "Keyboard driving"
      : "Click the panel to drive";
  const gamepadLabel = !gamepadOn
    ? "Gamepad off"
    : !windowFocused
      ? "Gamepad paused"
      : gamepad
        ? "Gamepad on"
        : "Gamepad: press a button on it";

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={onFocus}
      onBlur={onBlur}
      style={{
        height: "100%",
        overflow: "auto",
        boxSizing: "border-box",
        padding: 8,
        color: t.text,
        fontSize: 12,
        outline: `2px solid ${keyboardActive && !typing ? t.accent : "transparent"}`,
        outlineOffset: -2,
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
            void reZero();
          }}
          disabled={!resetPose.supported}
          title={
            resetPose.supported
              ? "Make the current position and heading the origin: x, y and yaw become 0 (depth, roll and pitch come from the sensors)"
              : "This connection cannot call services"
          }
        >
          Re-zero
        </ConfirmButton>
        <Button
          t={t}
          variant="danger"
          onClick={holdAll}
          title="Every axis stops smoothly and holds where it stops (Space, gamepad B)"
        >
          Hold all
        </Button>
        <Button t={t} onClick={level} title="Roll and pitch back to 0 (Z, gamepad Y)">
          Level
        </Button>
      </div>

      {notices.map(({ text, color }) => (
        <div key={text} style={{ color }}>
          {text}
        </div>
      ))}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 8,
        }}
      >
        <Card
          t={t}
          title="Position"
          extra={
            measured ? (
              <Readout
                t={t}
                measured={`${format(measured[X], 2)}, ${format(measured[Y], 2)}`}
                target={toGo != undefined ? `${format(toGo, 2)} m to go` : undefined}
              />
            ) : undefined
          }
        >
          <MapView
            pose={measured ? { x: measured[X], y: measured[Y], yaw: measured[YAW] } : undefined}
            target={xyTarget ? { ...xyTarget, yaw: yawTarget } : undefined}
            pending={
              pending[X] != undefined || pending[Y] != undefined
                ? { x: pending[X] ?? measured?.[X] ?? 0, y: pending[Y] ?? measured?.[Y] ?? 0 }
                : undefined
            }
            trail={trail}
            onPick={(x, y) => {
              setPendingAxes({ [X]: x, [Y]: y });
            }}
            t={t}
          />
          <Row>
            <Button
              t={t}
              onClick={() => {
                stepAxis(Y, -1);
              }}
              title="Step left (heading frame)"
            >
              ◀
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(X, 1);
              }}
              title="Step forward"
            >
              ▲ {steps.horizontal} m
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(X, -1);
              }}
              title="Step back"
            >
              ▼
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(Y, 1);
              }}
              title="Step right"
            >
              ▶
            </Button>
            <Button
              t={t}
              onClick={() => {
                trailRef.current = [];
                setTrail([]);
              }}
              title="Clear the track"
            >
              Clear trail
            </Button>
          </Row>
        </Card>

        <Card
          t={t}
          title="Heading"
          extra={
            measured ? (
              <Readout
                t={t}
                measured={pilotText(YAW, measured[YAW])}
                target={yawTarget != undefined ? pilotText(YAW, yawTarget) : undefined}
              />
            ) : undefined
          }
        >
          <Compass
            yaw={measured?.[YAW]}
            target={yawTarget}
            pending={pending[YAW]}
            onPick={(yaw) => {
              setPendingAxes({ [YAW]: yaw });
            }}
            t={t}
          />
          <Row>
            <Button
              t={t}
              onClick={() => {
                stepAxis(YAW, -1, 90 * DEG);
              }}
              title="Turn 90° left"
            >
              ↺ 90°
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(YAW, -1);
              }}
              title="Turn one step left"
            >
              ↺ {steps.yaw}°
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(YAW, 1);
              }}
              title="Turn one step right"
            >
              {steps.yaw}° ↻
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(YAW, 1, 90 * DEG);
              }}
              title="Turn 90° right"
            >
              90° ↻
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(YAW, 1, 180 * DEG);
              }}
              title="Turn around"
            >
              180°
            </Button>
          </Row>
        </Card>

        <Card
          t={t}
          title="Depth"
          extra={
            depth != undefined ? (
              <Readout
                t={t}
                measured={`${format(depth, 2)} m`}
                target={depthTarget != undefined ? pilotText(Z, depthTarget) : undefined}
              />
            ) : undefined
          }
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
            <DepthGauge
              depth={depth}
              target={depthTarget != undefined ? -depthTarget : undefined}
              pending={pending[Z] != undefined ? -pending[Z] : undefined}
              altitude={altitude}
              onPick={(d) => {
                setPendingAxes({ [Z]: -d });
              }}
              t={t}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              <Button
                t={t}
                onClick={() => {
                  stepAxis(Z, 1);
                }}
                title="Step up"
              >
                ▲ {steps.vertical} m
              </Button>
              <Button
                t={t}
                onClick={() => {
                  stepAxis(Z, -1);
                }}
                title="Step down"
              >
                ▼ {steps.vertical} m
              </Button>
              <div style={{ color: t.muted, lineHeight: 1.5 }}>
                <div>
                  Altitude{" "}
                  <span style={{ color: t.text }}>
                    {altitude != undefined ? `${format(altitude, 2)} m` : "—"}
                  </span>
                </div>
                {status?.altitude === true && (
                  <div style={{ color: t.target }}>
                    Holding {format(status.target[Z], 2)} m altitude
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card
          t={t}
          title="Attitude"
          extra={
            measured ? (
              <Readout
                t={t}
                measured={`R ${format(toPilot(ROLL, measured[ROLL]), 1)}°  P ${format(toPilot(PITCH, measured[PITCH]), 1)}°`}
              />
            ) : undefined
          }
        >
          <AttitudeIndicator
            roll={measured?.[ROLL]}
            pitch={measured ? -measured[PITCH] : undefined}
            targetRoll={controllerTarget(ROLL)}
            targetPitch={
              controllerTarget(PITCH) != undefined ? -controllerTarget(PITCH)! : undefined
            }
            pendingRoll={pending[ROLL]}
            pendingPitch={pending[PITCH] != undefined ? -pending[PITCH] : undefined}
            t={t}
          />
          <Row>
            <span style={{ color: t.muted }}>Roll</span>
            <Button
              t={t}
              onClick={() => {
                stepAxis(ROLL, -1);
              }}
              title="Roll left one step"
            >
              ◀
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(ROLL, 1);
              }}
              title="Roll right one step"
            >
              ▶
            </Button>
            <span style={{ color: t.muted, marginLeft: 6 }}>Pitch</span>
            <Button
              t={t}
              onClick={() => {
                stepAxis(PITCH, 1);
              }}
              title="Nose up one step"
            >
              ▲
            </Button>
            <Button
              t={t}
              onClick={() => {
                stepAxis(PITCH, -1);
              }}
              title="Nose down one step"
            >
              ▼
            </Button>
            <span style={{ color: t.muted }}>{steps.rollPitch}°</span>
          </Row>
        </Card>
      </div>

      <CommandCard
        t={t}
        modes={config.commandModes}
        onMode={(axis, mode) => {
          setCommandMode(axis, mode);
          const axes = axis === X || axis === Y ? [X, Y] : [axis];
          const positions = pendingRef.current.slice() as Targets;
          const velocities = pendingVelocityRef.current.slice() as Targets;
          for (const a of axes) {
            positions[a] = velocities[a] = undefined;
          }
          updatePending(positions);
          updatePendingVelocity(velocities);
        }}
        positions={pending}
        velocities={pendingVelocity}
        live={[0, 1, 2, 3, 4, 5].map((axis) => controllerTarget(axis) ?? measured?.[axis])}
        cruise={cruise}
        now={now}
        onPosition={(axis, value) => {
          setPendingAxes({ [axis]: value });
        }}
        onVelocity={setPendingVelocityAxis}
        frame={config.cruiseFrame}
        onFrame={(cruiseFrame) => {
          setConfig((previous) => ({ ...previous, cruiseFrame }));
        }}
        seconds={config.cruiseSeconds}
        onSeconds={(seconds) => {
          setConfig((previous) => ({
            ...previous,
            cruiseSeconds: limited("cruiseSeconds", seconds, previous.cruiseSeconds),
          }));
        }}
        onGo={go}
        onClear={clearPending}
        onStop={stopCruise}
      />

      <Card
        t={t}
        title="Manual control"
        extra={
          <span style={{ color: keyboardActive && !typing ? t.accent : t.muted }}>
            {keyboardLabel}
          </span>
        }
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button
            t={t}
            onClick={toggleGamepad}
            active={gamepadOn}
            title={gamepad?.id ?? "Use a gamepad (W3C standard mapping)"}
          >
            {gamepadLabel}
          </Button>
          <span style={{ color: t.muted }}>
            {config.command === "effort"
              ? "Efforts a full key press or stick sends"
              : "Speeds a full key press or stick sends"}
          </span>
        </div>
        <SpeedControls
          t={t}
          config={config}
          onSpeed={(key, value) => {
            setConfig((previous) => ({
              ...previous,
              maxSpeed: {
                ...previous.maxSpeed,
                [key]: limited(key, value, previous.maxSpeed[key]),
              },
            }));
          }}
          onEffort={(key, value) => {
            setConfig((previous) => ({
              ...previous,
              maxEffort: {
                ...previous.maxEffort,
                [key]: limited(key, value, previous.maxEffort[key]),
              },
            }));
          }}
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto auto minmax(60px, 180px) minmax(70px, auto) auto",
            columnGap: 12,
            rowGap: 4,
            alignItems: "center",
            justifyContent: "start",
          }}
        >
          {["Axis", "Mode", "Input", "Sent", "Controller"].map((heading) => (
            <span key={heading} style={{ color: t.muted, fontSize: 10 }}>
              {heading}
            </span>
          ))}
          {DOFS.map(({ label, positive }, dof) => (
            <ManualRow
              key={label}
              label={label}
              hint={`${keysFor(dof)} · + ${positive}`}
              mode={config.manual[dof]!}
              onMode={(mode) => {
                setManual(dof, mode);
              }}
              value={input[dof]!}
              sent={sent[dof]!}
              controller={modeName(status, dof)}
              t={t}
            />
          ))}
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
          {KEY_ROWS.map((cluster, index) => (
            <div
              key={index}
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${cluster[0]!.length}, 50px)`,
                gap: 3,
              }}
            >
              {cluster.flat().map((code, cell) => (
                <Key
                  key={cell}
                  code={code}
                  pressed={code != undefined && pressed.has(code)}
                  t={t}
                />
              ))}
            </div>
          ))}
          <div style={{ color: t.muted, lineHeight: 1.6, minWidth: 160, flex: 1 }}>
            <div>Space hold all · Z level · Enter go · Esc clear</div>
            <div>Rate axes hold when let go; Step axes move one step per press.</div>
            {gamepadOn && (
              <div>
                {config.gamepad
                  .map(({ source, invert }, dof) =>
                    source === "none"
                      ? undefined
                      : `${DOFS[dof]!.label}: ${GAMEPAD_SOURCES[source].label}${invert ? " (inverted)" : ""}`,
                  )
                  .filter(Boolean)
                  .join(" · ")}
                {" · B hold all · Y level"}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ManualRow({
  label,
  hint,
  mode,
  onMode,
  value,
  sent,
  controller,
  t,
}: {
  label: string;
  hint: string;
  mode: ManualMode;
  onMode: (mode: ManualMode) => void;
  value: number;
  sent: string;
  controller: string;
  t: Theme;
}): ReactElement {
  return (
    <>
      <span style={{ whiteSpace: "nowrap" }}>
        {label} <span style={{ color: t.muted, fontSize: 10 }}>{hint}</span>
      </span>
      <Segmented options={MANUAL_OPTIONS} value={mode} onChange={onMode} t={t} />
      <span style={{ opacity: mode === "lock" ? 0.35 : 1 }}>
        <Bar value={value} t={t} />
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{sent}</span>
      <span style={{ whiteSpace: "nowrap", color: t.muted }}>{controller}</span>
    </>
  );
}

export function initTeleopPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<TeleopPanel context={context} />);
  return () => {
    root.unmount();
  };
}
