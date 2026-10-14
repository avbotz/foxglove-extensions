// Detections as boxes on an image, and the fit of that image in the panel.

import { Stamp } from "../../common/msgs";

// sub_vision_interfaces/msg/Detection, the fields the panel reads.
export type Detection = {
  detection: {
    results: { hypothesis: { class_id: string; score: number } }[];
    bbox: {
      center: { position: { x: number; y: number }; theta: number };
      size_x: number;
      size_y: number;
    };
    id: string;
  };
  bearing_horizontal: number;
  bearing_vertical: number;
  distance_m: number;
  pose_valid: boolean;
};

export type DetectionArray = {
  header: { stamp: Stamp; frame_id: string };
  task: string;
  detections: Detection[];
};

/** A color, each channel in [0, 1]. */
export type Rgb = { r: number; g: number; b: number };

/** A box in image pixels, with its label and color. */
export type Box = { x: number; y: number; width: number; height: number; label: string; color: Rgb };

/** The same color for a class from frame to frame: a hue from its name, at HSL 85% / 55%. */
export function classColor(classId: string): Rgb {
  let hash = 7;
  for (const char of classId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 0.85;
  const lightness = 0.55;
  // CSS Color 4's HSL to RGB.
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return (
      lightness -
      saturation * Math.min(lightness, 1 - lightness) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    );
  };
  return { r: channel(0), g: channel(8), b: channel(4) };
}

export function cssColor({ r, g, b }: Rgb): string {
  return `rgb(${r * 255} ${g * 255} ${b * 255})`;
}

/** The boxes to draw: each detection's best hypothesis, those scoring at least `minScore`. */
export function boxesOf(message: DetectionArray, minScore: number): Box[] {
  const boxes: Box[] = [];
  for (const { detection, distance_m } of message.detections) {
    let best: { class_id: string; score: number } | undefined;
    for (const { hypothesis } of detection.results) {
      if (best == undefined || hypothesis.score > best.score) {
        best = hypothesis;
      }
    }
    if (best != undefined && best.score < minScore) {
      continue;
    }
    const parts: string[] = [];
    if (best != undefined) {
      parts.push(best.class_id, best.score.toFixed(2));
    }
    if (Number.isFinite(distance_m)) {
      parts.push(`${distance_m.toFixed(1)} m`);
    }
    const { bbox } = detection;
    boxes.push({
      x: bbox.center.position.x - bbox.size_x / 2,
      y: bbox.center.position.y - bbox.size_y / 2,
      width: bbox.size_x,
      height: bbox.size_y,
      label: parts.join(" "),
      color: classColor(best?.class_id ?? detection.id),
    });
  }
  return boxes;
}

/** Where an image of one size sits, whole, in a box of another: scale and offset. */
export type Fit = { scale: number; dx: number; dy: number };

export function fitContain(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
): Fit {
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  return {
    scale,
    dx: (boxWidth - imageWidth * scale) / 2,
    dy: (boxHeight - imageHeight * scale) / 2,
  };
}

export function drawBoxes(
  ctx: CanvasRenderingContext2D,
  boxes: readonly Box[],
  fit: Fit,
  options: { labels: boolean; lineWidth: number; fontPx: number },
): void {
  ctx.save();
  ctx.lineWidth = options.lineWidth;
  ctx.font = `${options.fontPx}px sans-serif`;
  ctx.textBaseline = "top";
  const pad = Math.ceil(options.fontPx / 4);
  for (const box of boxes) {
    const x = fit.dx + box.x * fit.scale;
    const y = fit.dy + box.y * fit.scale;
    const width = box.width * fit.scale;
    const height = box.height * fit.scale;
    ctx.strokeStyle = cssColor(box.color);
    ctx.strokeRect(x, y, width, height);
    if (!options.labels || box.label === "") {
      continue;
    }
    const labelWidth = ctx.measureText(box.label).width + 2 * pad;
    const labelHeight = options.fontPx + 2 * pad;
    // Above the box, or inside it at the top when there is no room.
    const labelY = y - labelHeight >= 0 ? y - labelHeight : y;
    ctx.fillStyle = cssColor(box.color);
    ctx.fillRect(x, labelY, labelWidth, labelHeight);
    ctx.fillStyle = "#000";
    ctx.fillText(box.label, x + pad, labelY + pad);
  }
  ctx.restore();
}
