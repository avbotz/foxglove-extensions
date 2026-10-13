// The path the vehicle traces, from above or from the side: the routine's waypoints, the
// controller's reference and the measured position. From above the view is as the teleop map,
// with odom +x up and +y left; from the side x or y runs right and z up.

import { ReactElement } from "react";

import { Theme } from "../../common/ui";

export type PathPoint = readonly [number, number, number];
export type PathViewKind = "xy" | "xz" | "yz";

const SIZE = 240;
const MARGIN = 14;
const GRID_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
const DEG = Math.PI / 180;

// Screen-right and screen-up components of a point, per view.
const PROJECTIONS: Record<PathViewKind, { h: (p: PathPoint) => number; v: (p: PathPoint) => number; right: string; up: string }> = {
  xy: { h: (p) => -p[1], v: (p) => p[0], right: "−y", up: "+x" },
  xz: { h: (p) => p[0], v: (p) => p[2], right: "+x", up: "+z" },
  yz: { h: (p) => p[1], v: (p) => p[2], right: "+y", up: "+z" },
};

export function PathView({
  view,
  measured,
  reference,
  planned,
  pose,
  t,
}: {
  view: PathViewKind;
  measured: readonly PathPoint[];
  reference: readonly PathPoint[];
  planned: readonly PathPoint[];
  pose: { point: PathPoint; yaw: number } | undefined;
  t: Theme;
}): ReactElement {
  const { h, v, right, up } = PROJECTIONS[view];
  const points: PathPoint[] = [[0, 0, 0], ...measured, ...reference, ...planned];
  if (pose) {
    points.push(pose.point);
  }
  const hs = points.map(h);
  const vs = points.map(v);
  const [minH, maxH, minV, maxV] = [Math.min(...hs), Math.max(...hs), Math.min(...vs), Math.max(...vs)];
  const span = Math.max(2, maxH - minH, maxV - minV) * 1.25;
  const [ch, cv] = [(minH + maxH) / 2, (minV + maxV) / 2];
  const scale = (SIZE - 2 * MARGIN) / span;
  const half = SIZE / 2;
  const sx = (p: PathPoint) => half + (h(p) - ch) * scale;
  const sy = (p: PathPoint) => half - (v(p) - cv) * scale;
  const grid = GRID_STEPS.find((step) => span / step <= 8) ?? 100;

  const lines: ReactElement[] = [];
  const first = (center: number) => Math.ceil((center - span / 2) / grid) * grid;
  for (let value = first(ch); value <= ch + span / 2; value += grid) {
    const x = half + (value - ch) * scale;
    lines.push(<line key={`h${value}`} x1={x} x2={x} y1={0} y2={SIZE} stroke={t.faint} />);
  }
  for (let value = first(cv); value <= cv + span / 2; value += grid) {
    const y = half - (value - cv) * scale;
    lines.push(<line key={`v${value}`} x1={0} x2={SIZE} y1={y} y2={y} stroke={t.faint} />);
  }
  const polyline = (trail: readonly PathPoint[]) => trail.map((p) => `${sx(p)},${sy(p)}`).join(" ");
  const origin: PathPoint = [0, 0, 0];

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ width: "100%", maxHeight: 320, display: "block" }}>
      <rect x={0} y={0} width={SIZE} height={SIZE} fill={t.water} rx={4} />
      {lines}
      <circle cx={sx(origin)} cy={sy(origin)} r={2} fill={t.muted} />
      {planned.length > 1 && (
        <polyline
          points={polyline(planned)}
          fill="none"
          stroke={t.pending}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}
      {planned.map((p, index) => (
        <circle key={index} cx={sx(p)} cy={sy(p)} r={3} fill="none" stroke={t.pending} />
      ))}
      {reference.length > 1 && (
        <polyline points={polyline(reference)} fill="none" stroke={t.target} strokeWidth={1.5} />
      )}
      {measured.length > 1 && (
        <polyline
          points={polyline(measured)}
          fill="none"
          stroke={t.accent}
          strokeOpacity={0.7}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )}
      {pose &&
        (view === "xy" ? (
          <g transform={`translate(${sx(pose.point)} ${sy(pose.point)}) rotate(${-pose.yaw / DEG})`}>
            <path d="M0 -9 L5.5 6 L0 3 L-5.5 6 Z" fill={t.accent} stroke={t.text} strokeWidth={0.6} />
          </g>
        ) : (
          <circle cx={sx(pose.point)} cy={sy(pose.point)} r={4} fill={t.accent} stroke={t.text} strokeWidth={0.6} />
        ))}
      {!pose && (
        <text x={half} y={half + 30} fontSize={11} textAnchor="middle" fill={t.muted}>
          No odometry
        </text>
      )}
      <text x={6} y={SIZE - 6} fontSize={9} fill={t.muted}>
        grid {grid} m
      </text>
      <text x={SIZE - 6} y={SIZE - 6} fontSize={9} fill={t.muted} textAnchor="end">
        {right} → · {up} ↑
      </text>
    </svg>
  );
}
