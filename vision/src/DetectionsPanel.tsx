// A camera view with sub_vision's detections drawn on the frames they were computed from. Frames
// and detections are paired by header stamp (sync.ts), so a box is never drawn on a later frame.

import { Immutable, PanelExtensionContext, SettingsTreeNodes, Topic } from "@foxglove/extension";
import { ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { RawImage, compressedMimeType, rawToRgba } from "./decode";
import { Box, DetectionArray, boxesOf, drawBoxes, fitContain } from "./draw";
import { FrameMode, FrameSync, Shown, Stamped, stampKey, stampSeconds } from "./sync";
import { Stamp, isCompressedImageSchema } from "../../common/msgs";
import {
  numberOr,
  record,
  stringOr,
  topicItems,
  useRenderState,
  useSettings,
} from "../../common/panel";
import { Theme, theme } from "../../common/ui";

type Config = {
  imageTopic: string;
  detectionsTopic: string;
  mode: FrameMode;
  waitMs: number;
  detectorTimeoutMs: number;
  minScore: number;
  labels: boolean;
  lineWidth: number;
};

// The front camera's JPEG copy, which sub_bringup records and which crosses the network.
const DEFAULT_CONFIG: Config = {
  imageTopic: "/marlin_v3/front_camera/image_color/compressed",
  detectionsTopic: "/marlin_v3/vision/detections",
  mode: "detected",
  waitMs: 150,
  detectorTimeoutMs: 1000,
  minScore: 0,
  labels: true,
  lineWidth: 2,
};

type ImageMessage = { schemaName: string; message: unknown };
type Frame = Stamped<ImageMessage>;
type Detections = Stamped<DetectionArray>;
type Info = {
  task: string;
  count: number | undefined;
  stamp: number;
  latencyMs: number | undefined;
  width: number;
  height: number;
};

// [ms] between checks for frames whose wait is over.
const TICK_MS = 50;

function loadConfig(saved: unknown): Config {
  const s = record(saved);
  const d = DEFAULT_CONFIG;
  return {
    imageTopic: stringOr(s.imageTopic, d.imageTopic),
    detectionsTopic: stringOr(s.detectionsTopic, d.detectionsTopic),
    mode: s.mode === "all" ? "all" : "detected",
    waitMs: numberOr(s.waitMs, d.waitMs, 0, 2000),
    detectorTimeoutMs: numberOr(s.detectorTimeoutMs, d.detectorTimeoutMs, 100, 30000),
    minScore: numberOr(s.minScore, d.minScore, 0, 1),
    labels: typeof s.labels === "boolean" ? s.labels : d.labels,
    lineWidth: numberOr(s.lineWidth, d.lineWidth, 1, 10),
  };
}

function applySetting(config: Config, path: readonly string[], value: unknown): Config {
  const [, field = ""] = path;
  const next = { ...config };
  if (field === "imageTopic" || field === "detectionsTopic") {
    next[field] = typeof value === "string" ? value.trim() : "";
  } else if (field === "mode") {
    next.mode = value === "all" ? "all" : "detected";
  } else if (field === "labels") {
    next.labels = value === true;
  } else if (
    field === "waitMs" ||
    field === "detectorTimeoutMs" ||
    field === "minScore" ||
    field === "lineWidth"
  ) {
    next[field] = value as number;
  }
  return loadConfig(next);
}

function buildSettings(config: Config, topics: Immutable<Topic[]>): SettingsTreeNodes {
  return {
    general: {
      label: "Detections",
      fields: {
        imageTopic: {
          label: "Image topic",
          input: "autocomplete",
          value: config.imageTopic,
          items: topicItems(topics, "image", config.imageTopic),
          help: "sensor_msgs/msg/Image or CompressedImage",
          error: config.imageTopic === "" ? "Set an image topic" : undefined,
        },
        detectionsTopic: {
          label: "Detections topic",
          input: "autocomplete",
          value: config.detectionsTopic,
          items: topicItems(topics, "detections", config.detectionsTopic),
          help: "sub_vision_interfaces/msg/DetectionArray, stamped like its source frame",
        },
        mode: {
          label: "Frames shown",
          input: "select",
          value: config.mode,
          options: [
            { label: "Only frames the detector processed", value: "detected" },
            { label: "Every frame", value: "all" },
          ],
          help: "While detections arrive. Without any, every frame is shown as it comes",
        },
        waitMs: {
          label: "Wait for detections (ms)",
          input: "number",
          value: config.waitMs,
          min: 0,
          max: 2000,
          step: 10,
          precision: 0,
          help: "Every frame: how long a frame waits for its detections before it is shown bare",
        },
        detectorTimeoutMs: {
          label: "Detector timeout (ms)",
          input: "number",
          value: config.detectorTimeoutMs,
          min: 100,
          max: 30000,
          step: 100,
          precision: 0,
          help: "Without detections for this long, the detector counts as off",
        },
        minScore: {
          label: "Minimum score",
          input: "number",
          value: config.minScore,
          min: 0,
          max: 1,
          step: 0.05,
          precision: 2,
        },
        labels: { label: "Labels", input: "boolean", value: config.labels },
        lineWidth: {
          label: "Line width",
          input: "number",
          value: config.lineWidth,
          min: 1,
          max: 10,
          step: 1,
          precision: 0,
        },
      },
    },
  };
}

function stampOf(message: unknown): Stamp {
  const stamp = record(record(record(message).header).stamp);
  return { sec: numberOr(stamp.sec, 0), nanosec: numberOr(stamp.nanosec, 0) };
}

async function decode(image: ImageMessage): Promise<ImageBitmap> {
  const m = record(image.message);
  if (isCompressedImageSchema(image.schemaName)) {
    const data = new Uint8Array(m.data as ArrayLike<number>);
    const blob = new Blob([data], { type: compressedMimeType(stringOr(m.format, "")) });
    return await createImageBitmap(blob);
  }
  const raw = m as unknown as RawImage;
  const rgba = rawToRgba(raw);
  return await createImageBitmap(new ImageData(rgba, raw.width, raw.height));
}

function DetectionsPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [config, setConfig] = useState(() => loadConfig(context.initialState));
  const [topics, setTopics] = useState<Immutable<Topic[]>>([]);
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("dark");
  const [info, setInfo] = useState<Info | undefined>();
  const [detectorLive, setDetectorLive] = useState(false);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const t = theme(colorScheme);
  const configRef = useRef(config);
  configRef.current = config;

  const nodes = useMemo(() => buildSettings(config, topics), [config, topics]);
  useSettings(context, config, nodes, applySetting, setConfig);

  const syncRef = useRef(new FrameSync<ImageMessage, DetectionArray>(config));
  syncRef.current.options = {
    mode: config.mode,
    waitMs: config.waitMs,
    detectorTimeoutMs: config.detectorTimeoutMs,
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The frame to draw next, the one being drawn, and what is on the canvas now.
  const nextRef = useRef<Shown<ImageMessage, DetectionArray> | undefined>(undefined);
  const busyRef = useRef(false);
  const lastRef = useRef<{ bitmap: ImageBitmap; boxes: Box[] } | undefined>(undefined);
  const drawTimesRef = useRef<number[]>([]);

  /** Redraws what is on the canvas, at the canvas's current size. */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const last = lastRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !last || !ctx) {
      return;
    }
    const dpr = window.devicePixelRatio;
    const fit = fitContain(last.bitmap.width, last.bitmap.height, canvas.width, canvas.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      last.bitmap,
      fit.dx,
      fit.dy,
      last.bitmap.width * fit.scale,
      last.bitmap.height * fit.scale,
    );
    const { labels, lineWidth } = configRef.current;
    drawBoxes(ctx, last.boxes, fit, { labels, lineWidth: lineWidth * dpr, fontPx: 12 * dpr });
  }, []);

  // Draws frames one at a time; while one decodes, only the newest waiting frame is kept.
  const pumpRef = useRef<() => void>(() => undefined);
  pumpRef.current = () => {
    const shown = nextRef.current;
    if (busyRef.current || shown == undefined) {
      return;
    }
    nextRef.current = undefined;
    busyRef.current = true;
    void (async () => {
      try {
        const bitmap = await decode(shown.frame.value);
        lastRef.current?.bitmap.close();
        lastRef.current = {
          bitmap,
          boxes: shown.detections
            ? boxesOf(shown.detections.value, configRef.current.minScore)
            : [],
        };
        redraw();
        const now = Date.now();
        drawTimesRef.current = [...drawTimesRef.current.filter((at) => now - at < 2000), now];
        setFps(drawTimesRef.current.length / 2);
        setInfo({
          task: shown.detections?.value.task ?? "",
          count: shown.detections?.value.detections.length,
          stamp: shown.frame.stamp,
          latencyMs: shown.detections
            ? shown.detections.receivedAt - shown.frame.receivedAt
            : undefined,
          width: bitmap.width,
          height: bitmap.height,
        });
        setError(undefined);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        busyRef.current = false;
        pumpRef.current();
      }
    })();
  };

  const show = useCallback((shown: Shown<ImageMessage, DetectionArray>[]) => {
    const last = shown[shown.length - 1];
    if (last) {
      nextRef.current = last;
      pumpRef.current();
    }
  }, []);

  useRenderState(context, ["currentFrame", "topics", "colorScheme", "didSeek"], (state) => {
    if (state.topics) {
      setTopics(state.topics);
    }
    if (state.colorScheme) {
      setColorScheme(state.colorScheme);
    }
    const sync = syncRef.current;
    if (state.didSeek === true) {
      sync.reset();
    }
    const now = Date.now();
    const { imageTopic, detectionsTopic } = configRef.current;
    const shown: Shown<ImageMessage, DetectionArray>[] = [];
    for (const event of state.currentFrame ?? []) {
      const stamp = stampOf(event.message);
      const stamped = { key: stampKey(stamp), stamp: stampSeconds(stamp), receivedAt: now };
      if (event.topic === imageTopic) {
        const frame: Frame = {
          ...stamped,
          value: { schemaName: event.schemaName, message: event.message },
        };
        shown.push(...sync.addFrame(frame, now));
      } else if (event.topic === detectionsTopic) {
        const detections: Detections = { ...stamped, value: event.message as DetectionArray };
        shown.push(...sync.addDetections(detections, now));
      }
    }
    show(shown);
  });

  // Frames whose wait is over, and the detector's state for the footer.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      show(syncRef.current.tick(now));
      setDetectorLive(syncRef.current.detectorLive(now));
    }, TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [show]);

  const { imageTopic, detectionsTopic } = config;
  useEffect(() => {
    syncRef.current.reset();
    nextRef.current = undefined;
    setInfo(undefined);
    context.subscribe(
      [imageTopic, detectionsTopic].filter((topic) => topic !== "").map((topic) => ({ topic })),
    );
  }, [context, imageTopic, detectionsTopic]);

  useEffect(() => {
    redraw();
  }, [config.labels, config.lineWidth, redraw]);

  // The canvas follows its container's size, in device pixels.
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
      redraw();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [redraw]);

  useEffect(() => {
    return () => {
      lastRef.current?.bitmap.close();
    };
  }, []);

  const modeText = !detectorLive
    ? "No detections: every frame"
    : config.mode === "detected"
      ? "Frames the detector processed"
      : "Every frame";

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        color: t.text,
        fontSize: 12,
        background: colorScheme === "dark" ? "#000" : "#111",
      }}
    >
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        {info == undefined && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#9a9aa6",
            }}
          >
            {imageTopic === "" ? "Set an image topic" : `Waiting for ${imageTopic}`}
          </div>
        )}
      </div>
      <Footer t={t} info={info} fps={fps} modeText={modeText} error={error} />
    </div>
  );
}

function Footer({
  t,
  info,
  fps,
  modeText,
  error,
}: {
  t: Theme;
  info: Info | undefined;
  fps: number;
  modeText: string;
  error: string | undefined;
}): ReactElement {
  const parts: string[] = [modeText];
  if (info) {
    parts.push(`${info.width}×${info.height}`, `${fps.toFixed(0)} fps`);
    if (info.count != undefined) {
      parts.push(
        `${info.count} ${info.task === "" ? "" : `${info.task} `}detection${info.count === 1 ? "" : "s"}`,
      );
    }
    if (info.latencyMs != undefined) {
      parts.push(`detector +${info.latencyMs.toFixed(0)} ms`);
    }
    parts.push(`t ${info.stamp.toFixed(3)}`);
  }
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "3px 8px",
        color: "#9a9aa6",
        whiteSpace: "nowrap",
        overflow: "hidden",
        fontVariantNumeric: "tabular-nums",
        background: "#1a1a1e",
      }}
    >
      {error != undefined ? <span style={{ color: t.danger }}>{error}</span> : undefined}
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
    </div>
  );
}

export function initDetectionsPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<DetectionsPanel context={context} />);
  return () => {
    root.unmount();
  };
}
