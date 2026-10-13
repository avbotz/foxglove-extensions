// Graphs the controller's signals per axis: target, reference and measurement, tracking error,
// velocities, wrench and disturbance, integrals; or any signals by name. The derived signals
// (signals.ts) are what the built-in Plot panel cannot show.

import { Immutable, PanelExtensionContext, SettingsTreeNodes, Topic } from "@foxglove/extension";
import { MouseEvent, ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ChartLayout, ChartSeries, drawChart } from "./chart";
import { AxisName, isAxisName } from "./routines";
import {
  SIGNAL_NAMES,
  SignalBuffer,
  ViewKey,
  VIEWS,
  isViewKey,
  measuredState,
  signalsOf,
  viewSignals,
} from "./signals";
import {
  AXIS_NAMES,
  ControllerStatus,
  DEFAULT_ALTITUDE_TOPIC,
  DEFAULT_ODOMETRY_TOPIC,
  DEFAULT_STATUS_TOPIC,
  Odometry,
  Range,
  rangeAltitude,
} from "../../common/msgs";
import { numberOr, record, stringOr, topicItems, useRenderState, useSettings } from "../../common/panel";
import { Button, NumberInput, Segmented, Theme, inputStyle, theme } from "../../common/ui";

type Config = {
  statusTopic: string;
  odometryTopic: string;
  altitudeTopic: string;
  axis: AxisName;
  view: ViewKey;
  custom: string[];
  windowS: number;
  /** "auto", or ±range, or "custom" with the limits below. */
  yRange: "auto" | "custom" | number;
  yMin: number;
  yMax: number;
};

const DEFAULT_CONFIG: Config = {
  statusTopic: DEFAULT_STATUS_TOPIC,
  odometryTopic: DEFAULT_ODOMETRY_TOPIC,
  altitudeTopic: DEFAULT_ALTITUDE_TOPIC,
  axis: "z",
  view: "pose",
  custom: [],
  windowS: 30,
  yRange: "auto",
  yMin: -1,
  yMax: 1,
};

const WINDOWS = [10, 30, 60, 120, 300];
const Y_RANGES = [0.1, 0.5, 1, 2, 5, 20, 50];
// The longest window, so a shorter one can be widened without losing what was seen.
const BUFFER_S = Math.max(...WINDOWS);
const COLORS = ["#55a7ff", "#ffb020", "#25d8ff", "#8d7cff", "#78e6b2", "#f5c451", "#ff7f9f", "#b4c8e8"];
// [ms] between legend updates.
const LEGEND_MS = 250;

function loadConfig(saved: unknown): Config {
  const s = record(saved);
  const d = DEFAULT_CONFIG;
  const yRange =
    s.yRange === "custom" ? "custom" : typeof s.yRange === "number" && s.yRange > 0 ? s.yRange : "auto";
  return {
    statusTopic: stringOr(s.statusTopic, d.statusTopic),
    odometryTopic: stringOr(s.odometryTopic, d.odometryTopic),
    altitudeTopic: stringOr(s.altitudeTopic, d.altitudeTopic),
    axis: isAxisName(s.axis) ? s.axis : d.axis,
    view: isViewKey(s.view) ? s.view : d.view,
    custom: Array.isArray(s.custom)
      ? (s.custom as unknown[]).filter((n): n is string => typeof n === "string")
      : d.custom,
    windowS: WINDOWS.includes(numberOr(s.windowS, d.windowS)) ? numberOr(s.windowS, d.windowS) : d.windowS,
    yRange,
    yMin: numberOr(s.yMin, d.yMin),
    yMax: numberOr(s.yMax, d.yMax),
  };
}

const TOPIC_FIELDS = ["statusTopic", "odometryTopic", "altitudeTopic"] as const;

function applySetting(config: Config, path: readonly string[], value: unknown): Config {
  const [, field] = path;
  const topicField = TOPIC_FIELDS.find((name) => name === field);
  if (topicField != undefined) {
    return { ...config, [topicField]: typeof value === "string" ? value.trim() : "" };
  }
  return config;
}

function buildSettings(config: Config, topics: Immutable<Topic[]>): SettingsTreeNodes {
  return {
    general: {
      label: "Signals",
      fields: {
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
          help: "nav_msgs/msg/Odometry: the measured pose and velocity",
        },
        altitudeTopic: {
          label: "Altitude topic",
          input: "autocomplete",
          value: config.altitudeTopic,
          items: topicItems(topics, "altitude", config.altitudeTopic),
          help: "sensor_msgs/msg/Range from the DVL",
        },
      },
    },
  };
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function selectStyle(t: Theme) {
  return { ...inputStyle(t), padding: "2px 4px" };
}

function SignalsPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [config, setConfig] = useState(() => loadConfig(context.initialState));
  const [topics, setTopics] = useState<Immutable<Topic[]>>([]);
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("dark");
  const [paused, setPaused] = useState(false);
  const [legend, setLegend] = useState<{ name: string; value: number | undefined }[]>([]);
  const [hoverT, setHoverT] = useState<number | undefined>();
  const [customText, setCustomText] = useState(() => config.custom.join(", "));
  const t = theme(colorScheme);
  const configRef = useRef(config);
  configRef.current = config;
  const nodes = useMemo(() => buildSettings(config, topics), [config, topics]);
  useSettings(context, config, nodes, applySetting, setConfig);

  const bufferRef = useRef(new SignalBuffer(BUFFER_S));
  const odometryRef = useRef<Odometry | undefined>(undefined);
  const altitudeRef = useRef<number | undefined>(undefined);
  const pausedAtRef = useRef<number | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<ChartLayout | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const hoverRef = useRef<number | undefined>(undefined);
  hoverRef.current = hoverT;

  const names = useMemo(
    () => viewSignals(config.view, config.axis, config.custom),
    [config.view, config.axis, config.custom],
  );
  const namesRef = useRef(names);
  namesRef.current = names;

  const draw = useCallback(() => {
    frameRef.current = undefined;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const buffer = bufferRef.current;
    const { windowS, yRange, yMin, yMax } = configRef.current;
    const series: ChartSeries[] = namesRef.current.map((name, index) => {
      const s = buffer.series(name);
      return { name, color: COLORS[index % COLORS.length]!, t: s?.t ?? [], v: s?.v ?? [] };
    });
    const tEnd = pausedAtRef.current ?? buffer.latest;
    const limits =
      yRange === "auto"
        ? [undefined, undefined]
        : yRange === "custom"
          ? [yMin, yMax]
          : [-yRange, yRange];
    layoutRef.current = drawChart(
      canvas,
      series,
      { tEnd: Number.isFinite(tEnd) ? tEnd : 0, windowS, yMin: limits[0], yMax: limits[1] },
      { text: t.text, muted: t.muted, grid: t.faint, cursor: t.pending },
      hoverRef.current,
    );
  }, [t.faint, t.muted, t.pending, t.text]);

  const scheduleDraw = useCallback(() => {
    frameRef.current ??= requestAnimationFrame(draw);
  }, [draw]);

  useRenderState(context, ["currentFrame", "topics", "colorScheme", "didSeek"], (state) => {
    if (state.topics) {
      setTopics(state.topics);
    }
    if (state.colorScheme) {
      setColorScheme(state.colorScheme);
    }
    const buffer = bufferRef.current;
    if (state.didSeek === true) {
      buffer.clear();
    }
    const { statusTopic, odometryTopic, altitudeTopic } = configRef.current;
    let added = false;
    for (const event of state.currentFrame ?? []) {
      const time = event.receiveTime.sec + event.receiveTime.nsec * 1e-9;
      if (event.topic === odometryTopic) {
        odometryRef.current = event.message as Odometry;
        buffer.add(time, signalsOf(undefined, measuredState(odometryRef.current, undefined, undefined), undefined));
        added = true;
      } else if (event.topic === altitudeTopic) {
        altitudeRef.current = rangeAltitude(event.message as Range);
      } else if (event.topic === statusTopic) {
        const status = event.message as ControllerStatus;
        const odometry = odometryRef.current;
        const measured = odometry ? measuredState(odometry, status, altitudeRef.current) : undefined;
        buffer.add(time, signalsOf(status, measured, altitudeRef.current));
        added = true;
      }
    }
    if (added && pausedAtRef.current == undefined) {
      scheduleDraw();
    }
  });

  const { statusTopic, odometryTopic, altitudeTopic } = config;
  useEffect(() => {
    context.subscribe(
      [...new Set([statusTopic, odometryTopic, altitudeTopic])].filter((topic) => topic !== "").map((topic) => ({ topic })),
    );
  }, [context, statusTopic, odometryTopic, altitudeTopic]);

  useEffect(() => {
    scheduleDraw();
  }, [config, hoverT, scheduleDraw]);

  // The legend: the latest value of each signal, or the value under the cursor.
  useEffect(() => {
    const update = () => {
      const buffer = bufferRef.current;
      const at = hoverRef.current;
      setLegend(
        namesRef.current.map((name) => ({
          name,
          value: at == undefined ? buffer.latestValue(name) : buffer.valueAt(name, at),
        })),
      );
    };
    update();
    const id = setInterval(update, LEGEND_MS);
    return () => {
      clearInterval(id);
    };
  }, [names]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio;
      canvas.width = Math.max(1, Math.round(container.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(container.clientHeight * dpr));
      draw();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [draw]);

  const onMouseMove = (event: MouseEvent<HTMLCanvasElement>) => {
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) {
      return;
    }
    const x = ((event.clientX - canvas.getBoundingClientRect().left) * canvas.width) / canvas.clientWidth;
    if (x < layout.left || x > layout.right) {
      setHoverT(undefined);
      return;
    }
    setHoverT(layout.tStart + ((x - layout.left) / (layout.right - layout.left)) * (layout.tEnd - layout.tStart));
  };

  const togglePause = () => {
    pausedAtRef.current = paused ? undefined : bufferRef.current.latest;
    setPaused(!paused);
    scheduleDraw();
  };

  const commitCustom = () => {
    const custom = customText
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter((name) => name !== "");
    setConfig((previous) => ({ ...previous, custom }));
  };

  const update = (change: Partial<Config>) => {
    setConfig((previous) => ({ ...previous, ...change }));
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", color: t.text, fontSize: 12 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "6px 8px 2px" }}>
        <Segmented
          options={AXIS_NAMES.map((axis) => ({ value: axis, label: axis }))}
          value={config.axis}
          onChange={(axis) => {
            update({ axis });
          }}
          t={t}
        />
        <select
          value={config.view}
          onChange={(event) => {
            update({ view: isViewKey(event.target.value) ? event.target.value : "pose" });
          }}
          style={selectStyle(t)}
        >
          {Object.entries(VIEWS).map(([key, { label }]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {config.view === "custom" && (
          <>
            <input
              list="avbotz-signal-names"
              value={customText}
              placeholder="signals, comma separated"
              onChange={(event) => {
                setCustomText(event.target.value);
              }}
              onBlur={commitCustom}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitCustom();
                }
              }}
              style={{ ...inputStyle(t), width: 260 }}
            />
            <datalist id="avbotz-signal-names">
              {SIGNAL_NAMES.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        )}
        <select
          value={config.windowS}
          onChange={(event) => {
            update({ windowS: Number(event.target.value) });
          }}
          style={selectStyle(t)}
          title="Time window"
        >
          {WINDOWS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds} s
            </option>
          ))}
        </select>
        <select
          value={String(config.yRange)}
          onChange={(event) => {
            const value = event.target.value;
            update({ yRange: value === "auto" || value === "custom" ? value : Number(value) });
          }}
          style={selectStyle(t)}
          title="Y range"
        >
          <option value="auto">Y auto</option>
          {Y_RANGES.map((range) => (
            <option key={range} value={range}>
              ±{range}
            </option>
          ))}
          <option value="custom">Y custom</option>
        </select>
        {config.yRange === "custom" && (
          <>
            <NumberInput
              value={config.yMin}
              digits={3}
              width={56}
              onChange={(value) => {
                if (value != undefined && Number.isFinite(value)) {
                  update({ yMin: value });
                }
              }}
              t={t}
            />
            <NumberInput
              value={config.yMax}
              digits={3}
              width={56}
              onChange={(value) => {
                if (value != undefined && Number.isFinite(value)) {
                  update({ yMax: value });
                }
              }}
              t={t}
            />
          </>
        )}
        <Button t={t} onClick={togglePause} active={paused} title="Freeze the view; data keeps arriving">
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          t={t}
          onClick={() => {
            bufferRef.current.clear();
            scheduleDraw();
          }}
        >
          Clear
        </Button>
        <Button
          t={t}
          onClick={() => {
            download(`signals_${config.axis}_${config.view}.csv`, bufferRef.current.csv(names));
          }}
          title="The plotted signals, as far back as the buffer holds"
        >
          CSV
        </Button>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 60, position: "relative" }}>
        <canvas
          ref={canvasRef}
          onMouseMove={onMouseMove}
          onMouseLeave={() => {
            setHoverT(undefined);
          }}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "2px 8px 6px", fontVariantNumeric: "tabular-nums" }}>
        {legend.map(({ name, value }, index) => (
          <span key={name} style={{ whiteSpace: "nowrap" }}>
            <span style={{ color: COLORS[index % COLORS.length], fontWeight: 700 }}>— </span>
            <span style={{ color: t.muted }}>{name}</span>{" "}
            {value == undefined ? "—" : Number(value.toPrecision(5)).toString()}
          </span>
        ))}
        {legend.length === 0 && <span style={{ color: t.muted }}>Pick signals to plot</span>}
        {hoverT != undefined && <span style={{ color: t.pending }}>at {((pausedAtRef.current ?? bufferRef.current.latest) - hoverT > 0 ? "−" : "") + Math.abs((pausedAtRef.current ?? bufferRef.current.latest) - hoverT).toFixed(2)} s</span>}
      </div>
    </div>
  );
}

export function initSignalsPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<SignalsPanel context={context} />);
  return () => {
    root.unmount();
  };
}
