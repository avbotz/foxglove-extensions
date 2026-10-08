// Data plumbing both panels share: the render loop, the topics they read, publishing
// MotionSetpoint, and the settings editor.

import {
  Immutable,
  PanelExtensionContext,
  SettingsTreeAction,
  SettingsTreeNodes,
  Topic,
} from "@foxglove/extension";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  ControllerStatus,
  MOTION_SETPOINT_DATATYPES,
  MOTION_SETPOINT_SCHEMA,
  MotionSetpoint,
  Odometry,
  Range,
  isControllerStatusSchema,
  isMotionSetpointSchema,
  isOdometrySchema,
  isRangeSchema,
} from "./msgs";

// Data older than this is not shown as current.
export const STALE_MS = 1000;

export type Received<T> = { message: T; receivedAt: number };

export type SourceTopics = { status: string; odometry?: string; altitude?: string };

export type PanelData = {
  topics: Immutable<Topic[]>;
  status: Received<ControllerStatus> | undefined;
  odometry: Received<Odometry> | undefined;
  altitude: Received<Range> | undefined;
  colorScheme: "dark" | "light";
};

/** Runs the panel's render loop and keeps the latest message on each source topic. */
export function usePanelData(context: PanelExtensionContext, sources: SourceTopics): PanelData {
  const [topics, setTopics] = useState<Immutable<Topic[]>>([]);
  const [status, setStatus] = useState<Received<ControllerStatus> | undefined>();
  const [odometry, setOdometry] = useState<Received<Odometry> | undefined>();
  const [altitude, setAltitude] = useState<Received<Range> | undefined>();
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("dark");
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.topics) {
        setTopics(renderState.topics);
      }
      if (renderState.colorScheme) {
        setColorScheme(renderState.colorScheme);
      }
      const latest = new Map<string, unknown>();
      for (const event of renderState.currentFrame ?? []) {
        latest.set(event.topic, event.message);
      }
      const receivedAt = Date.now();
      const take = <T,>(topic: string | undefined, set: (value: Received<T>) => void) => {
        const message = topic ? latest.get(topic) : undefined;
        if (message != undefined) {
          set({ message: message as T, receivedAt });
        }
      };
      const {
        status: statusTopic,
        odometry: odometryTopic,
        altitude: altitudeTopic,
      } = sourcesRef.current;
      take<ControllerStatus>(statusTopic, setStatus);
      take<Odometry>(odometryTopic, setOdometry);
      take<Range>(altitudeTopic, setAltitude);
    };
    context.watch("topics");
    context.watch("currentFrame");
    context.watch("colorScheme");
  }, [context]);

  const {
    status: statusTopic,
    odometry: odometryTopic = "",
    altitude: altitudeTopic = "",
  } = sources;
  useEffect(() => {
    setStatus(undefined);
    setOdometry(undefined);
    setAltitude(undefined);
    const wanted = [statusTopic, odometryTopic, altitudeTopic].filter((topic) => topic !== "");
    context.subscribe([...new Set(wanted)].map((topic) => ({ topic })));
  }, [context, statusTopic, odometryTopic, altitudeTopic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return { topics, status, odometry, altitude, colorScheme };
}

export function fresh<T>(received: Received<T> | undefined, now: number): T | undefined {
  return received != undefined && now - received.receivedAt <= STALE_MS
    ? received.message
    : undefined;
}

/** Seconds since `received` arrived, if it has gone stale. */
export function staleSeconds<T>(
  received: Received<T> | undefined,
  now: number,
): number | undefined {
  return received != undefined && now - received.receivedAt > STALE_MS
    ? (now - received.receivedAt) / 1000
    : undefined;
}

/** Re-renders every `intervalMs`, for displays that age. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

export type Publisher = {
  /** Publishes and returns an error message if that failed. */
  publish: (message: MotionSetpoint) => string | undefined;
  supported: boolean;
};

/**
 * Advertises MotionSetpoint on `topic` for as long as the panel uses it. `beforeUnadvertise`
 * runs as the topic is given up (topic change or panel closed) and may return one last
 * message, so the panel can stop what it was driving.
 */
export function useSetpointPublisher(
  context: PanelExtensionContext,
  topic: string,
  beforeUnadvertise?: () => MotionSetpoint | undefined,
): Publisher {
  const beforeUnadvertiseRef = useRef(beforeUnadvertise);
  beforeUnadvertiseRef.current = beforeUnadvertise;

  useEffect(() => {
    if (topic === "" || context.advertise == undefined) {
      return;
    }
    context.advertise(topic, MOTION_SETPOINT_SCHEMA, { datatypes: MOTION_SETPOINT_DATATYPES });
    return () => {
      const last = beforeUnadvertiseRef.current?.();
      if (last) {
        try {
          context.publish?.(topic, last);
        } catch {
          // Nothing more to do: the controller's stream timeout stops the vehicle.
        }
      }
      context.unadvertise?.(topic);
    };
  }, [context, topic]);

  const publish = useCallback(
    (message: MotionSetpoint) => {
      if (context.publish == undefined) {
        return "This connection cannot publish";
      }
      if (topic === "") {
        return "No command topic set";
      }
      try {
        context.publish(topic, message);
        return undefined;
      } catch (error) {
        return `Publish failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    [context, topic],
  );

  return { publish, supported: context.publish != undefined };
}

export type ResetPose = {
  supported: boolean;
  /** Calls the re-zero service; resolves to an error message, or undefined on success. */
  call: () => Promise<string | undefined>;
};

/** sub_control's reset_pose (std_srvs/Trigger): the current position and heading become zero. */
export function useResetPose(context: PanelExtensionContext, service: string): ResetPose {
  const call = useCallback(async () => {
    if (context.callService == undefined) {
      return "This connection cannot call services";
    }
    if (service === "") {
      return "No re-zero service set";
    }
    try {
      const response = record(await context.callService(service, {}));
      return response.success === true
        ? undefined
        : `Re-zero refused: ${stringOr(response.message, "no reason given")}`;
    } catch (error) {
      return `Re-zero failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, [context, service]);
  return { supported: context.callService != undefined, call };
}

const SCHEMA_MATCHERS = {
  setpoint: isMotionSetpointSchema,
  status: isControllerStatusSchema,
  odometry: isOdometrySchema,
  altitude: isRangeSchema,
};

/** Topic names for the settings autocomplete, the configured one first. */
export function topicItems(
  topics: Immutable<Topic[]>,
  kind: keyof typeof SCHEMA_MATCHERS,
  current: string,
): string[] {
  const matches = SCHEMA_MATCHERS[kind];
  const names = topics.filter((topic) => matches(topic.schemaName)).map((topic) => topic.name);
  return [...new Set([current, ...names])].filter((name) => name !== "");
}

/** Wires a settings tree to config updates and persists the config. */
export function useSettings<T extends object>(
  context: PanelExtensionContext,
  config: T,
  nodes: SettingsTreeNodes,
  apply: (config: T, path: readonly string[], value: unknown) => T,
  setConfig: (update: (config: T) => T) => void,
): void {
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action !== "update") {
        return;
      }
      const { path, value } = action.payload;
      setConfig((previous) => apply(previous, path, value));
    },
    [apply, setConfig],
  );

  useEffect(() => {
    context.updatePanelSettingsEditor({ actionHandler, nodes });
  }, [context, actionHandler, nodes]);

  useEffect(() => {
    context.saveState(config);
  }, [context, config]);
}

export function numberOr(
  value: unknown,
  fallback: number,
  min = -Infinity,
  max = Infinity,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != undefined ? (value as Record<string, unknown>) : {};
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
