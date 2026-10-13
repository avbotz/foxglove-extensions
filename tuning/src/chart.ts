// A line chart on a canvas: time on x, the last `windowS` seconds ending at `tEnd`.

export type ChartSeries = { name: string; color: string; t: readonly number[]; v: readonly number[] };

export type ChartRange = {
  tEnd: number;
  windowS: number;
  /** Fixed limits, or undefined to fit the data. */
  yMin: number | undefined;
  yMax: number | undefined;
};

export type ChartColors = { text: string; muted: string; grid: string; cursor: string };

/** Where the plot area sits in the canvas, in canvas pixels, and the axes it maps. */
export type ChartLayout = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  tStart: number;
  tEnd: number;
  yMin: number;
  yMax: number;
};

/** Limits that fit the data in the window, a little padded; a flat line gets a band around it. */
export function fitRange(
  series: readonly ChartSeries[],
  tStart: number,
  tEnd: number,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const { t, v } of series) {
    for (let i = 0; i < t.length; i++) {
      const time = t[i]!;
      if (time >= tStart && time <= tEnd) {
        const value = v[i]!;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [-1, 1];
  }
  const span = max - min;
  const pad = span > 0 ? span * 0.1 : Math.max(Math.abs(min) * 0.1, 0.1);
  return [min - pad, max + pad];
}

/** A tick step of 1, 2 or 5 × 10ⁿ giving about `count` ticks over `span`. */
export function niceStep(span: number, count: number): number {
  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  return (residual >= 5 ? 5 : residual >= 2 ? 2 : 1) * magnitude;
}

function tickLabel(value: number, step: number): string {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toFixed(Math.min(6, digits));
}

export function drawChart(
  canvas: HTMLCanvasElement,
  series: readonly ChartSeries[],
  range: ChartRange,
  colors: ChartColors,
  hoverT: number | undefined,
): ChartLayout | undefined {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return undefined;
  }
  const dpr = window.devicePixelRatio;
  const width = canvas.width;
  const height = canvas.height;
  const font = 10 * dpr;
  const layout: ChartLayout = {
    left: 52 * dpr,
    right: width - 8 * dpr,
    top: 8 * dpr,
    bottom: height - 18 * dpr,
    tStart: range.tEnd - range.windowS,
    tEnd: range.tEnd,
    yMin: 0,
    yMax: 1,
  };
  [layout.yMin, layout.yMax] =
    range.yMin != undefined && range.yMax != undefined && range.yMax > range.yMin
      ? [range.yMin, range.yMax]
      : fitRange(series, layout.tStart, layout.tEnd);

  const plotWidth = layout.right - layout.left;
  const plotHeight = layout.bottom - layout.top;
  const sx = (t: number) => layout.left + ((t - layout.tStart) / range.windowS) * plotWidth;
  const sy = (v: number) =>
    layout.bottom - ((v - layout.yMin) / (layout.yMax - layout.yMin)) * plotHeight;

  ctx.clearRect(0, 0, width, height);
  ctx.font = `${font}px sans-serif`;
  ctx.lineWidth = dpr;

  // Grid and labels.
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.muted;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  const yStep = niceStep(layout.yMax - layout.yMin, 5);
  for (let v = Math.ceil(layout.yMin / yStep) * yStep; v <= layout.yMax + 1e-9; v += yStep) {
    const y = sy(v);
    ctx.beginPath();
    ctx.moveTo(layout.left, y);
    ctx.lineTo(layout.right, y);
    ctx.stroke();
    ctx.fillText(tickLabel(v, yStep), layout.left - 4 * dpr, y);
  }
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  const tStep = niceStep(range.windowS, 6);
  for (let back = 0; back <= range.windowS + 1e-9; back += tStep) {
    const x = sx(layout.tEnd - back);
    ctx.beginPath();
    ctx.moveTo(x, layout.top);
    ctx.lineTo(x, layout.bottom);
    ctx.stroke();
    ctx.fillText(back === 0 ? "0 s" : `−${tickLabel(back, tStep)}`, x, layout.bottom + 3 * dpr);
  }
  // Zero line.
  if (layout.yMin < 0 && layout.yMax > 0) {
    ctx.strokeStyle = colors.muted;
    ctx.beginPath();
    ctx.moveTo(layout.left, sy(0));
    ctx.lineTo(layout.right, sy(0));
    ctx.stroke();
  }

  // The lines.
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.left, layout.top, plotWidth, plotHeight);
  ctx.clip();
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  for (const { color, t, v } of series) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < t.length; i++) {
      const time = t[i]!;
      if (time < layout.tStart - 1 || time > layout.tEnd) {
        continue;
      }
      const x = sx(time);
      const y = sy(v[i]!);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  if (hoverT != undefined && hoverT >= layout.tStart && hoverT <= layout.tEnd) {
    ctx.strokeStyle = colors.cursor;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(sx(hoverT), layout.top);
    ctx.lineTo(sx(hoverT), layout.bottom);
    ctx.stroke();
  }
  ctx.restore();
  return layout;
}
