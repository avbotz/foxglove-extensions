// The pilot panel's instruments, drawn in SVG. Each shows the measured state (accent), the
// controller's target (teal) and a pending target the operator has picked but not sent
// (amber, dashed). Clicking one picks a pending target.
//
// The map and compass are drawn from above with odom +x up and +y left, so yaw is
// counterclockwise from up, as it is in odom.

import { MouseEvent, ReactElement, useId } from "react";

import { Theme } from "./ui";

const DEG = Math.PI / 180;

function svgPoint(event: MouseEvent<SVGSVGElement>): { x: number; y: number } | undefined {
  const matrix = event.currentTarget.getScreenCTM();
  if (!matrix) {
    return undefined;
  }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step + 0;
}

function svgStyle(maxHeight: number) {
  return {
    width: "100%",
    maxHeight,
    display: "block",
    cursor: "crosshair",
    userSelect: "none" as const,
  };
}

// --- Map ---

export type MapPose = { x: number; y: number; yaw?: number };

const MAP_SIZE = 240;
const MAP_MARGIN = 14;
const GRID_STEPS = [0.25, 0.5, 1, 2, 5, 10, 20, 50];

export function MapView({
  pose,
  target,
  pending,
  trail,
  onPick,
  t,
}: {
  pose: MapPose | undefined;
  target: MapPose | undefined;
  pending: MapPose | undefined;
  trail: readonly (readonly [number, number])[];
  onPick: (x: number, y: number) => void;
  t: Theme;
}): ReactElement {
  // Fit everything worth seeing, and the origin, with at least 4 m across.
  const points: (readonly [number, number])[] = [[0, 0], ...trail];
  for (const p of [pose, target, pending]) {
    if (p) {
      points.push([p.x, p.y]);
    }
  }
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const span = Math.max(4, maxX - minX, maxY - minY) * 1.25;
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
  const scale = (MAP_SIZE - 2 * MAP_MARGIN) / span;
  const half = MAP_SIZE / 2;
  const sx = (y: number) => half - (y - cy) * scale;
  const sy = (x: number) => half - (x - cx) * scale;
  const grid = GRID_STEPS.find((step) => span / step <= 8) ?? 100;

  const lines: ReactElement[] = [];
  const first = (center: number) => Math.ceil((center - span / 2) / grid) * grid;
  for (let x = first(cx); x <= cx + span / 2; x += grid) {
    const y = sy(x);
    lines.push(
      <line key={`x${x}`} x1={0} x2={MAP_SIZE} y1={y} y2={y} stroke={t.faint} strokeWidth={1} />,
    );
  }
  for (let y = first(cy); y <= cy + span / 2; y += grid) {
    const x = sx(y);
    lines.push(
      <line key={`y${y}`} y1={0} y2={MAP_SIZE} x1={x} x2={x} stroke={t.faint} strokeWidth={1} />,
    );
  }

  const heading = (yaw: number | undefined) => (yaw == undefined ? 0 : -yaw / DEG);
  const axisLength = Math.min(grid, span / 6) * scale;

  return (
    <svg
      viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`}
      style={svgStyle(320)}
      onClick={(event) => {
        const point = svgPoint(event);
        if (point) {
          onPick(
            snap(cx - (point.y - half) / scale, 0.05),
            snap(cy - (point.x - half) / scale, 0.05),
          );
        }
      }}
    >
      <rect x={0} y={0} width={MAP_SIZE} height={MAP_SIZE} fill={t.water} rx={4} />
      {lines}
      {/* Odom origin and axes. */}
      <g stroke={t.muted} strokeWidth={1.2} fill={t.muted}>
        <line x1={sx(0)} y1={sy(0)} x2={sx(0)} y2={sy(0) - axisLength} />
        <line x1={sx(0)} y1={sy(0)} x2={sx(0) - axisLength} y2={sy(0)} />
        <circle cx={sx(0)} cy={sy(0)} r={2} />
      </g>
      <text x={sx(0) + 3} y={sy(0) - axisLength + 8} fontSize={9} fill={t.muted}>
        +x
      </text>
      <text x={sx(0) - axisLength} y={sy(0) - 4} fontSize={9} fill={t.muted}>
        +y
      </text>
      {trail.length > 1 && (
        <polyline
          points={trail.map(([x, y]) => `${sx(y)},${sy(x)}`).join(" ")}
          fill="none"
          stroke={t.accent}
          strokeOpacity={0.45}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )}
      {pose && target && (
        <line
          x1={sx(pose.y)}
          y1={sy(pose.x)}
          x2={sx(target.y)}
          y2={sy(target.x)}
          stroke={t.target}
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      {target && (
        <g transform={`translate(${sx(target.y)} ${sy(target.x)})`}>
          <circle r={6} fill="none" stroke={t.target} strokeWidth={2} />
          {target.yaw != undefined && (
            <line
              x1={0}
              y1={-6}
              x2={0}
              y2={-12}
              stroke={t.target}
              strokeWidth={2}
              transform={`rotate(${heading(target.yaw)})`}
            />
          )}
        </g>
      )}
      {pending && (
        <g transform={`translate(${sx(pending.y)} ${sy(pending.x)})`} stroke={t.pending}>
          <circle r={8} fill="none" strokeWidth={1.5} strokeDasharray="3 2" />
          <line x1={-4} x2={4} y1={0} y2={0} />
          <line x1={0} x2={0} y1={-4} y2={4} />
        </g>
      )}
      {pose && (
        <g transform={`translate(${sx(pose.y)} ${sy(pose.x)}) rotate(${heading(pose.yaw)})`}>
          <path d="M0 -10 L6 7 L0 3.5 L-6 7 Z" fill={t.accent} stroke={t.text} strokeWidth={0.6} />
        </g>
      )}
      {!pose && (
        <text x={half} y={half + 30} fontSize={11} textAnchor="middle" fill={t.muted}>
          No odometry
        </text>
      )}
      <text x={6} y={MAP_SIZE - 6} fontSize={9} fill={t.muted}>
        grid {grid} m
      </text>
    </svg>
  );
}

// --- Compass ---

const DIAL = 200;
const DIAL_C = DIAL / 2;
const DIAL_R = 84;

/** A point at counterclockwise angle `yaw` from up, `r` from the center. */
function onDial(yaw: number, r: number): [number, number] {
  return [DIAL_C - r * Math.sin(yaw), DIAL_C - r * Math.cos(yaw)];
}

export function Compass({
  yaw,
  target,
  pending,
  onPick,
  t,
}: {
  yaw: number | undefined;
  target: number | undefined;
  pending: number | undefined;
  onPick: (yaw: number) => void;
  t: Theme;
}): ReactElement {
  const ticks: ReactElement[] = [];
  for (let deg = -165; deg <= 180; deg += 15) {
    const major = deg % 45 === 0;
    const [x1, y1] = onDial(deg * DEG, DIAL_R);
    const [x2, y2] = onDial(deg * DEG, DIAL_R - (major ? 10 : 5));
    ticks.push(
      <line
        key={deg}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={major ? t.muted : t.border}
        strokeWidth={major ? 1.5 : 1}
      />,
    );
    if (major) {
      const [lx, ly] = onDial(deg * DEG, DIAL_R - 20);
      ticks.push(
        <text
          key={`l${deg}`}
          x={lx}
          y={ly + 3}
          fontSize={9}
          textAnchor="middle"
          fill={deg === 0 ? t.text : t.muted}
          fontWeight={deg === 0 ? 700 : 400}
        >
          {deg}
        </text>,
      );
    }
  }
  const marker = (angle: number, color: string, line: "solid" | "dashed") => {
    const dashed = line === "dashed";
    const [tipX, tipY] = onDial(angle, DIAL_R - 13);
    const [ax, ay] = onDial(angle + 6 * DEG, DIAL_R + 3);
    const [bx, by] = onDial(angle - 6 * DEG, DIAL_R + 3);
    return (
      <polygon
        points={`${tipX},${tipY} ${ax},${ay} ${bx},${by}`}
        fill={dashed ? "none" : color}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={dashed ? "2 2" : undefined}
      />
    );
  };
  return (
    <svg
      viewBox={`0 0 ${DIAL} ${DIAL}`}
      style={svgStyle(240)}
      onClick={(event) => {
        const point = svgPoint(event);
        if (point && Math.hypot(point.x - DIAL_C, point.y - DIAL_C) > 12) {
          const angle = Math.atan2(-(point.x - DIAL_C), -(point.y - DIAL_C));
          onPick(snap(angle / DEG, 5) * DEG);
        }
      }}
    >
      <circle cx={DIAL_C} cy={DIAL_C} r={DIAL_R + 6} fill={t.water} />
      <circle cx={DIAL_C} cy={DIAL_C} r={DIAL_R} fill="none" stroke={t.border} strokeWidth={1.5} />
      {ticks}
      {pending != undefined && (
        <>
          <line
            x1={DIAL_C}
            y1={DIAL_C}
            x2={onDial(pending, DIAL_R)[0]}
            y2={onDial(pending, DIAL_R)[1]}
            stroke={t.pending}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          {marker(pending, t.pending, "dashed")}
        </>
      )}
      {target != undefined && marker(target, t.target, "solid")}
      {yaw != undefined ? (
        <g transform={`rotate(${-yaw / DEG} ${DIAL_C} ${DIAL_C})`}>
          <path
            d={`M${DIAL_C} ${DIAL_C - 46} L${DIAL_C + 11} ${DIAL_C + 12} L${DIAL_C + 7} ${DIAL_C + 30}
                L${DIAL_C - 7} ${DIAL_C + 30} L${DIAL_C - 11} ${DIAL_C + 12} Z`}
            fill={t.accent}
            fillOpacity={0.85}
            stroke={t.text}
            strokeWidth={0.8}
          />
        </g>
      ) : (
        <text x={DIAL_C} y={DIAL_C + 4} fontSize={11} textAnchor="middle" fill={t.muted}>
          No odometry
        </text>
      )}
    </svg>
  );
}

// --- Depth ---

const GAUGE_W = 120;
const GAUGE_H = 240;
const GAUGE_TOP = 16;
const GAUGE_BOTTOM = GAUGE_H - 10;
const BAR_X = 44;
const BAR_W = 46;

function niceCeil(value: number): number {
  const step = value <= 4 ? 0.5 : value <= 10 ? 1 : 2;
  return Math.ceil(value / step) * step;
}

export function DepthGauge({
  depth,
  target,
  pending,
  altitude,
  onPick,
  t,
}: {
  /** Measured depth [m, down +]. */
  depth: number | undefined;
  target: number | undefined;
  pending: number | undefined;
  /** Height above the bottom from the DVL [m]. */
  altitude: number | undefined;
  onPick: (depth: number) => void;
  t: Theme;
}): ReactElement {
  const floor = depth != undefined && altitude != undefined ? depth + altitude : undefined;
  const maxDepth = niceCeil(
    Math.max(2, ...[depth, target, pending].map((d) => (d ?? 0) + 0.5), (floor ?? 0) + 0.3),
  );
  const toY = (d: number) => GAUGE_TOP + (d / maxDepth) * (GAUGE_BOTTOM - GAUGE_TOP);
  const tickStep = maxDepth <= 3 ? 0.5 : maxDepth <= 10 ? 1 : 2;
  const ticks: ReactElement[] = [];
  for (let d = 0; d <= maxDepth + 1e-9; d += tickStep) {
    const y = toY(d);
    ticks.push(
      <g key={d}>
        <line x1={BAR_X - 5} x2={BAR_X} y1={y} y2={y} stroke={t.muted} />
        <text x={BAR_X - 8} y={y + 3} fontSize={9} textAnchor="end" fill={t.muted}>
          {d.toFixed(tickStep < 1 ? 1 : 0)}
        </text>
        <line x1={BAR_X} x2={BAR_X + BAR_W} y1={y} y2={y} stroke={t.faint} />
      </g>,
    );
  }
  const right = BAR_X + BAR_W;
  return (
    <svg
      viewBox={`0 0 ${GAUGE_W} ${GAUGE_H}`}
      style={{ ...svgStyle(260), width: "auto", height: 240, maxWidth: "100%" }}
      onClick={(event) => {
        const point = svgPoint(event);
        if (point) {
          const d = ((point.y - GAUGE_TOP) / (GAUGE_BOTTOM - GAUGE_TOP)) * maxDepth;
          onPick(snap(Math.max(0, Math.min(maxDepth, d)), 0.05));
        }
      }}
    >
      <rect
        x={BAR_X}
        y={GAUGE_TOP}
        width={BAR_W}
        height={GAUGE_BOTTOM - GAUGE_TOP}
        fill={t.water}
        stroke={t.border}
      />
      {floor != undefined && floor < maxDepth && (
        <>
          <rect
            x={BAR_X}
            y={toY(floor)}
            width={BAR_W}
            height={GAUGE_BOTTOM - toY(floor)}
            fill={t.ground}
            fillOpacity={0.55}
          />
          <text
            x={BAR_X + BAR_W / 2}
            y={toY(floor) + 11}
            fontSize={8}
            textAnchor="middle"
            fill={t.text}
          >
            bottom
          </text>
        </>
      )}
      {ticks}
      <line
        x1={BAR_X - 4}
        x2={right + 4}
        y1={GAUGE_TOP}
        y2={GAUGE_TOP}
        stroke={t.accent}
        strokeWidth={1.5}
      />
      <text x={BAR_X + BAR_W / 2} y={GAUGE_TOP - 4} fontSize={8} textAnchor="middle" fill={t.muted}>
        surface
      </text>
      {pending != undefined && (
        <g stroke={t.pending} fill="none" strokeWidth={1.5}>
          <line x1={BAR_X} x2={right} y1={toY(pending)} y2={toY(pending)} strokeDasharray="4 3" />
          <polygon
            points={`${right + 1},${toY(pending)} ${right + 9},${toY(pending) - 5} ${right + 9},${toY(pending) + 5}`}
            strokeDasharray="2 2"
          />
        </g>
      )}
      {target != undefined && (
        <polygon
          points={`${right + 1},${toY(target)} ${right + 9},${toY(target) - 5} ${right + 9},${toY(target) + 5}`}
          fill={t.target}
        />
      )}
      {depth != undefined && (
        <g transform={`translate(${BAR_X + BAR_W / 2} ${toY(Math.min(depth, maxDepth))})`}>
          <ellipse rx={15} ry={5} fill={t.accent} stroke={t.text} strokeWidth={0.6} />
          <rect x={-4} y={-9} width={8} height={5} rx={1.5} fill={t.accent} />
        </g>
      )}
    </svg>
  );
}

// --- Attitude ---

const ATT = 200;
const ATT_C = ATT / 2;
const ATT_R = 76;
const PX_PER_DEG = 1.6;

/** A point at clockwise angle `angle` [deg] from up, `r` from the center. */
function onRollScale(angle: number, r: number): [number, number] {
  return [ATT_C + r * Math.sin(angle * DEG), ATT_C - r * Math.cos(angle * DEG)];
}

export function AttitudeIndicator({
  roll,
  pitch,
  targetRoll,
  targetPitch,
  pendingRoll,
  pendingPitch,
  t,
}: {
  /** Roll [rad, right +] and pitch [rad, nose up +]. */
  roll: number | undefined;
  pitch: number | undefined;
  targetRoll: number | undefined;
  targetPitch: number | undefined;
  pendingRoll: number | undefined;
  pendingPitch: number | undefined;
  t: Theme;
}): ReactElement {
  const clipId = useId();
  const rollDeg = (roll ?? 0) / DEG;
  const pitchDeg = (pitch ?? 0) / DEG;
  // Nose up moves the horizon down; a right roll turns it counterclockwise.
  const horizon = `rotate(${-rollDeg} ${ATT_C} ${ATT_C}) translate(0 ${pitchDeg * PX_PER_DEG})`;
  const ladder: ReactElement[] = [];
  for (let a = -80; a <= 80; a += 10) {
    if (a === 0) {
      continue;
    }
    const y = ATT_C - a * PX_PER_DEG;
    const w = a % 20 === 0 ? 22 : 12;
    ladder.push(
      <g key={a}>
        <line x1={ATT_C - w} x2={ATT_C + w} y1={y} y2={y} stroke="#fff" strokeOpacity={0.75} />
        {a % 20 === 0 && (
          <text x={ATT_C + w + 4} y={y + 3} fontSize={8} fill="#fff" fillOpacity={0.85}>
            {a}
          </text>
        )}
      </g>,
    );
  }
  const pitchLine = (value: number, color: string, line: "solid" | "dashed") => (
    <line
      x1={ATT_C - 34}
      x2={ATT_C + 34}
      y1={ATT_C - (value / DEG) * PX_PER_DEG}
      y2={ATT_C - (value / DEG) * PX_PER_DEG}
      stroke={color}
      strokeWidth={2.5}
      strokeDasharray={line === "dashed" ? "5 3" : undefined}
    />
  );
  const rollTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((angle) => {
    const [x1, y1] = onRollScale(angle, ATT_R + 2);
    const [x2, y2] = onRollScale(angle, ATT_R + (angle % 30 === 0 ? 10 : 6));
    return <line key={angle} x1={x1} y1={y1} x2={x2} y2={y2} stroke={t.muted} strokeWidth={1.2} />;
  });
  const rollMarker = (
    value: number,
    color: string,
    line: "solid" | "dashed",
    side: "inner" | "outer",
  ) => {
    const dashed = line === "dashed";
    const inward = side === "inner";
    const angle = -value / DEG;
    const r1 = inward ? ATT_R + 12 : ATT_R + 1;
    const r2 = inward ? ATT_R + 3 : ATT_R + 9;
    const [tipX, tipY] = onRollScale(angle, r2);
    const [ax, ay] = onRollScale(angle - 4, r1);
    const [bx, by] = onRollScale(angle + 4, r1);
    return (
      <polygon
        points={`${tipX},${tipY} ${ax},${ay} ${bx},${by}`}
        fill={dashed ? "none" : color}
        stroke={color}
        strokeWidth={1.3}
        strokeDasharray={dashed ? "2 2" : undefined}
      />
    );
  };
  return (
    <svg viewBox={`0 0 ${ATT} ${ATT}`} style={{ ...svgStyle(240), cursor: "default" }}>
      <defs>
        <clipPath id={clipId}>
          <circle cx={ATT_C} cy={ATT_C} r={ATT_R} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <g transform={horizon}>
          <rect x={-200} y={-400} width={600} height={400 + ATT_C} fill={t.sky} />
          <rect x={-200} y={ATT_C} width={600} height={400} fill={t.ground} />
          <line x1={-200} x2={400} y1={ATT_C} y2={ATT_C} stroke="#fff" strokeWidth={1.5} />
          {ladder}
          {pendingPitch != undefined && pitchLine(pendingPitch, t.pending, "dashed")}
          {targetPitch != undefined && pitchLine(targetPitch, t.target, "solid")}
        </g>
      </g>
      <circle cx={ATT_C} cy={ATT_C} r={ATT_R} fill="none" stroke={t.border} strokeWidth={1.5} />
      {rollTicks}
      {targetRoll != undefined && rollMarker(targetRoll, t.target, "solid", "inner")}
      {pendingRoll != undefined && rollMarker(pendingRoll, t.pending, "dashed", "inner")}
      {roll != undefined && rollMarker(roll, t.accent, "solid", "outer")}
      {/* The vehicle, fixed. */}
      <path
        d={`M${ATT_C - 44} ${ATT_C} H${ATT_C - 14} L${ATT_C} ${ATT_C + 10} L${ATT_C + 14} ${ATT_C} H${ATT_C + 44}`}
        fill="none"
        stroke={t.accent}
        strokeWidth={3.5}
        strokeLinejoin="round"
      />
      <circle cx={ATT_C} cy={ATT_C} r={2.5} fill={t.accent} />
      {roll == undefined && (
        <text x={ATT_C} y={ATT_C + 34} fontSize={11} textAnchor="middle" fill="#fff">
          No odometry
        </text>
      )}
    </svg>
  );
}
