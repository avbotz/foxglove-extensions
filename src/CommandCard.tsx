// The pilot panel's Command card, which sends a position or angle, or a velocity or angular
// velocity, on each axis, and the speed controls for manual driving.

import { ReactElement } from "react";

import { Cruise } from "./cruise";
import { ROLL, Six, X, Y } from "./msgs";
import { PILOT_LABELS, Targets, fromPilot, toPilot } from "./targets";
import { CommandMode, TeleopConfig } from "./teleopConfig";
import { Button, Card, NumberInput, Segmented, Theme, format } from "./ui";

const MODE_OPTIONS: { value: CommandMode; label: string; title: string }[] = [
  { value: "position", label: "Pos", title: "Go to a position or angle and hold it" },
  { value: "velocity", label: "Vel", title: "Move at a velocity or angular velocity" },
];

function velocityHint(axis: number, frame: "heading" | "world"): string {
  if (axis === X) {
    return frame === "heading" ? "fwd +" : "odom";
  }
  if (axis === Y) {
    return frame === "heading" ? "left +" : "odom";
  }
  return PILOT_LABELS[axis]!.hint;
}

function velocityUnit(axis: number): string {
  return axis >= ROLL ? "°/s" : "m/s";
}

export function CommandCard({
  t,
  modes,
  onMode,
  positions,
  velocities,
  live,
  cruise,
  now,
  onPosition,
  onVelocity,
  frame,
  onFrame,
  seconds,
  onSeconds,
  onGo,
  onClear,
  onStop,
}: {
  t: Theme;
  modes: Six<CommandMode>;
  onMode: (axis: number, mode: CommandMode) => void;
  /** Pending targets [m, rad, odom]. */
  positions: Targets;
  /** Pending velocities [m/s, rad/s, odom signs]. */
  velocities: Targets;
  /** What the position fields show when nothing is pending. */
  live: readonly (number | undefined)[];
  cruise: Cruise | undefined;
  now: number;
  onPosition: (axis: number, value: number | undefined) => void;
  onVelocity: (axis: number, value: number | undefined) => void;
  frame: "heading" | "world";
  onFrame: (frame: "heading" | "world") => void;
  seconds: number;
  onSeconds: (seconds: number) => void;
  onGo: () => void;
  onClear: () => void;
  onStop: () => void;
}): ReactElement {
  const pendingCount = modes.filter((mode, axis) =>
    mode === "position" ? positions[axis] != undefined : velocities[axis] != undefined,
  ).length;
  const cruiseText = cruise
    ? cruise.velocity
        .map((value, axis) =>
          value == undefined
            ? undefined
            : `${PILOT_LABELS[axis]!.name} ${format(toPilot(axis, value), axis >= ROLL ? 0 : 2)} ${velocityUnit(axis)}`,
        )
        .filter(Boolean)
        .join(" · ") +
      (cruise.until != undefined
        ? ` · ${Math.max(0, (cruise.until - now) / 1000).toFixed(0)} s left`
        : " · until stopped")
    : undefined;

  return (
    <Card
      t={t}
      title="Command"
      extra={
        <span style={{ color: pendingCount > 0 ? t.pending : t.muted }}>
          {pendingCount > 0
            ? `${pendingCount} pending: Go to send`
            : "Type a value or click an instrument"}
        </span>
      }
    >
      <div
        style={{
          display: "grid",
          // At most three columns.
          gridTemplateColumns:
            "repeat(auto-fill, minmax(max(250px, calc((100% - 16px) / 3)), 1fr))",
          gap: 8,
        }}
      >
        {PILOT_LABELS.map(({ name, unit, hint }, axis) => {
          const mode = modes[axis]!;
          const isVelocity = mode === "velocity";
          const pending = isVelocity ? velocities[axis] : positions[axis];
          const cruiseValue = cruise?.velocity[axis];
          const shown = pending ?? (isVelocity ? cruiseValue : live[axis]);
          const color =
            pending != undefined
              ? t.pending
              : isVelocity && cruiseValue != undefined
                ? t.target
                : t.muted;
          return (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 38, flexShrink: 0, color: t.muted }}>{name}</span>
              <Segmented
                options={MODE_OPTIONS}
                value={mode}
                onChange={(next) => {
                  onMode(axis, next);
                }}
                t={t}
              />
              <NumberInput
                value={shown != undefined ? toPilot(axis, shown) : undefined}
                digits={axis >= ROLL ? 1 : 2}
                width={58}
                onChange={(v) => {
                  const value = v == undefined ? undefined : fromPilot(axis, v);
                  (isVelocity ? onVelocity : onPosition)(axis, value);
                }}
                onEnter={onGo}
                onEscape={onClear}
                t={t}
                style={{ borderColor: pending != undefined ? t.pending : t.border, color }}
              />
              <span style={{ color: t.muted, whiteSpace: "nowrap" }}>
                {isVelocity ? velocityUnit(axis) : unit}{" "}
                <span style={{ fontSize: 10 }}>
                  {isVelocity ? velocityHint(axis, frame) : hint}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: t.muted }}>Velocities</span>
        <Segmented
          options={[
            { value: "heading", label: "Heading", title: "x forward and y left along the yaw" },
            { value: "world", label: "Odom x/y", title: "Along odom x and y" },
          ]}
          value={frame}
          onChange={onFrame}
          t={t}
        />
        <span style={{ color: t.muted }}>run for</span>
        <NumberInput
          value={seconds}
          digits={1}
          width={48}
          onChange={(v) => {
            onSeconds(v ?? 0);
          }}
          t={t}
        />
        <span style={{ color: t.muted }}>s (0: until stopped)</span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          t={t}
          variant="pending"
          onClick={onGo}
          disabled={pendingCount === 0}
          title="Send the pending targets and velocities (Enter)"
        >
          Go
        </Button>
        <Button
          t={t}
          onClick={onClear}
          disabled={pendingCount === 0}
          title="Drop the pending values (Esc)"
        >
          Clear
        </Button>
        <Button
          t={t}
          variant="danger"
          onClick={onStop}
          disabled={cruise == undefined}
          title="Stop the velocities and hold where the vehicle stops"
        >
          Stop velocities
        </Button>
        <span style={{ color: cruiseText != undefined ? t.target : t.muted }}>
          {cruiseText ??
            "Positions hold once reached. Velocities are resent by the panel and stop if it goes away."}
        </span>
      </div>
    </Card>
  );
}

type SpeedRow = {
  label: string;
  unit: string;
  value: number;
  max: number;
  step: number;
  digits: number;
  set: (value: number) => void;
};

function SpeedSlider({ row, t }: { row: SpeedRow; t: Theme }): ReactElement {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ width: 70, flexShrink: 0, color: t.muted }}>{row.label}</span>
      <input
        type="range"
        min={0}
        max={row.max}
        step={row.step}
        value={Math.min(row.value, row.max)}
        onChange={(event) => {
          row.set(Number(event.target.value));
        }}
        style={{ flex: 1, minWidth: 60, accentColor: t.accent }}
      />
      <NumberInput
        value={row.value}
        digits={row.digits}
        width={46}
        onChange={(v) => {
          if (v != undefined && Number.isFinite(v)) {
            row.set(v);
          }
        }}
        t={t}
      />
      <span style={{ width: 28, color: t.muted }}>{row.unit}</span>
    </label>
  );
}

/** The speeds (or efforts) a full key press or stick sends. */
export function SpeedControls({
  t,
  config,
  onSpeed,
  onEffort,
}: {
  t: Theme;
  config: TeleopConfig;
  onSpeed: (key: keyof TeleopConfig["maxSpeed"], value: number) => void;
  onEffort: (key: keyof TeleopConfig["maxEffort"], value: number) => void;
}): ReactElement {
  const rows: SpeedRow[] =
    config.command === "effort"
      ? [
          {
            label: "Force",
            unit: "N",
            value: config.maxEffort.force,
            max: 60,
            step: 1,
            digits: 0,
            set: (v) => {
              onEffort("force", v);
            },
          },
          {
            label: "Torque",
            unit: "N·m",
            value: config.maxEffort.torque,
            max: 15,
            step: 0.5,
            digits: 1,
            set: (v) => {
              onEffort("torque", v);
            },
          },
        ]
      : [
          {
            label: "Surge/sway",
            unit: "m/s",
            value: config.maxSpeed.horizontal,
            max: 1,
            step: 0.01,
            digits: 2,
            set: (v) => {
              onSpeed("horizontal", v);
            },
          },
          {
            label: "Heave",
            unit: "m/s",
            value: config.maxSpeed.vertical,
            max: 0.5,
            step: 0.01,
            digits: 2,
            set: (v) => {
              onSpeed("vertical", v);
            },
          },
          {
            label: "Yaw",
            unit: "°/s",
            value: config.maxSpeed.yaw,
            max: 90,
            step: 1,
            digits: 0,
            set: (v) => {
              onSpeed("yaw", v);
            },
          },
          {
            label: "Roll/pitch",
            unit: "°/s",
            value: config.maxSpeed.rollPitch,
            max: 45,
            step: 1,
            digits: 0,
            set: (v) => {
              onSpeed("rollPitch", v);
            },
          },
        ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
        gap: "4px 14px",
      }}
    >
      {rows.map((row) => (
        <SpeedSlider key={row.label} row={row} t={t} />
      ))}
    </div>
  );
}
