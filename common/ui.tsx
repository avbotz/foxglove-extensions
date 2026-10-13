// Presentational pieces both panels share: theme, cards, buttons, inputs and the status line.

import { CSSProperties, ReactElement, ReactNode, useEffect, useRef, useState } from "react";

import { ControllerStatus, MODE_NAMES } from "./msgs";

export type Theme = {
  text: string;
  muted: string;
  faint: string;
  border: string;
  surface: string;
  surfaceStrong: string;
  accent: string;
  accentSoft: string;
  target: string;
  pending: string;
  ok: string;
  warn: string;
  danger: string;
  water: string;
  sky: string;
  ground: string;
};

export function theme(colorScheme: "dark" | "light"): Theme {
  return colorScheme === "dark"
    ? {
        text: "#e6e6ea",
        muted: "#9a9aa6",
        faint: "rgba(255, 255, 255, 0.07)",
        border: "rgba(255, 255, 255, 0.14)",
        surface: "rgba(255, 255, 255, 0.035)",
        surfaceStrong: "rgba(255, 255, 255, 0.08)",
        accent: "#a78bfa",
        accentSoft: "rgba(167, 139, 250, 0.22)",
        target: "#2dd4bf",
        pending: "#fbbf24",
        ok: "#3fb950",
        warn: "#d29922",
        danger: "#f85149",
        water: "rgba(56, 139, 253, 0.10)",
        sky: "#25557f",
        ground: "#6a4a2c",
      }
    : {
        text: "#1f1f24",
        muted: "#62626e",
        faint: "rgba(0, 0, 0, 0.06)",
        border: "rgba(0, 0, 0, 0.14)",
        surface: "rgba(0, 0, 0, 0.025)",
        surfaceStrong: "rgba(0, 0, 0, 0.06)",
        accent: "#6d28d9",
        accentSoft: "rgba(109, 40, 217, 0.14)",
        target: "#0f8a7e",
        pending: "#b45309",
        ok: "#1a7f37",
        warn: "#9a6700",
        danger: "#cf222e",
        water: "rgba(9, 105, 218, 0.07)",
        sky: "#8ec1ea",
        ground: "#bf9568",
      };
}

export function format(value: number | undefined, digits: number): string {
  if (value == undefined || !Number.isFinite(value)) {
    return "—";
  }
  return (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toFixed(digits);
}

export function Card({
  title,
  extra,
  children,
  t,
  style,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  t: Theme;
  style?: CSSProperties;
}): ReactElement {
  return (
    <section
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        background: t.surface,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
        ...style,
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 8, minHeight: 16 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: t.muted,
          }}
        >
          {title}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontVariantNumeric: "tabular-nums",
            textAlign: "right",
            minWidth: 0,
          }}
        >
          {extra}
        </span>
      </header>
      {children}
    </section>
  );
}

type ButtonVariant = "normal" | "primary" | "danger" | "pending";

export function Button({
  children,
  onClick,
  t,
  variant = "normal",
  title,
  disabled = false,
  active = false,
  style,
}: {
  children: ReactNode;
  onClick: () => void;
  t: Theme;
  variant?: ButtonVariant;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  style?: CSSProperties;
}): ReactElement {
  const color = {
    normal: t.text,
    primary: t.accent,
    danger: t.danger,
    pending: t.pending,
  }[variant];
  return (
    <button
      type="button"
      // Not a tab stop: Space and Enter belong to the panel's own shortcuts.
      tabIndex={-1}
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        font: "inherit",
        fontSize: 12,
        color: variant === "normal" ? t.text : color,
        background: active ? t.accentSoft : t.surfaceStrong,
        border: `1px solid ${variant === "normal" ? (active ? t.accent : t.border) : color}`,
        borderRadius: 4,
        padding: "3px 9px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** A button that asks for a second click within a few seconds before it acts. */
export function ConfirmButton({
  children,
  confirm,
  onConfirm,
  t,
  title,
  disabled = false,
}: {
  children: ReactNode;
  confirm: string;
  onConfirm: () => void;
  t: Theme;
  title?: string;
  disabled?: boolean;
}): ReactElement {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) {
      return;
    }
    const id = setTimeout(() => {
      setArmed(false);
    }, 3000);
    return () => {
      clearTimeout(id);
    };
  }, [armed]);
  return (
    <Button
      t={t}
      variant={armed ? "pending" : "normal"}
      title={title}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirm : children}
    </Button>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  t,
}: {
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  t: Theme;
}): ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        border: `1px solid ${t.border}`,
        borderRadius: 4,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            tabIndex={-1}
            title={option.title}
            onClick={() => {
              onChange(option.value);
            }}
            style={{
              font: "inherit",
              fontSize: 11,
              padding: "2px 7px",
              border: "none",
              borderLeft: index === 0 ? "none" : `1px solid ${t.border}`,
              background: selected ? t.accentSoft : "transparent",
              color: selected ? t.text : t.muted,
              fontWeight: selected ? 600 : 400,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </span>
  );
}

export function inputStyle(t: Theme): CSSProperties {
  return {
    font: "inherit",
    fontSize: 12,
    color: t.text,
    background: t.surfaceStrong,
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    padding: "2px 5px",
    minWidth: 0,
  };
}

/**
 * A text box for a number. It tolerates partial input like "-" or "1." while typing, and
 * follows `value` from outside only while it does not have focus.
 */
export function NumberInput({
  value,
  onChange,
  onEnter,
  onEscape,
  disabled = false,
  digits = 3,
  width = 64,
  t,
  style,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  onEnter?: () => void;
  onEscape?: () => void;
  disabled?: boolean;
  digits?: number;
  width?: number;
  t: Theme;
  style?: CSSProperties;
}): ReactElement {
  const show = (v: number | undefined) =>
    v == undefined || !Number.isFinite(v) ? "" : String(Number(v.toFixed(digits)));
  const [text, setText] = useState(() => show(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(show(value));
    }
    // `show` only depends on `digits`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, digits]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={disabled ? "" : text}
      disabled={disabled}
      onFocus={(event) => {
        focused.current = true;
        event.target.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(show(value));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && onEnter) {
          event.preventDefault();
          event.currentTarget.blur();
          onEnter();
        } else if (event.key === "Escape" && onEscape) {
          event.preventDefault();
          event.currentTarget.blur();
          onEscape();
        }
      }}
      onChange={(event) => {
        setText(event.target.value);
        const trimmed = event.target.value.trim();
        const parsed = Number(trimmed);
        onChange(trimmed === "" ? undefined : Number.isFinite(parsed) ? parsed : NaN);
      }}
      style={{
        ...inputStyle(t),
        width,
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        opacity: disabled ? 0.4 : 1,
        ...style,
      }}
    />
  );
}

export function Badge({
  label,
  color,
  t,
}: {
  label: string;
  color: string;
  t: Theme;
}): ReactElement {
  return (
    <span
      style={{
        border: `1px solid ${color}`,
        color,
        borderRadius: 4,
        padding: "0 6px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        whiteSpace: "nowrap",
        background: t.surface,
      }}
    >
      {label}
    </span>
  );
}

/** Controller health on one line: killed, failsafe, and which feedback is live. */
export function StatusBar({
  status,
  stale,
  statusTopic,
  t,
}: {
  status: ControllerStatus | undefined;
  /** Seconds since the last status, when it is too old to show. */
  stale: number | undefined;
  statusTopic: string;
  t: Theme;
}): ReactElement {
  if (status == undefined) {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Badge label="NO STATUS" color={t.warn} t={t} />
        <span style={{ color: t.muted }}>
          {stale == undefined
            ? `Waiting for ${statusTopic || "a status topic"}`
            : `Last status ${stale.toFixed(0)} s ago`}
        </span>
      </span>
    );
  }
  const lost = [0, 1, 2, 3, 4, 5].filter((axis) => status.axis_controllable[axis] === false).length;
  const saturated = Array.from(status.thruster_saturated).filter(Boolean).length;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {status.killed ? (
        <Badge label="KILLED" color={t.danger} t={t} />
      ) : (
        <Badge label="LIVE" color={t.ok} t={t} />
      )}
      {!status.killed && !status.armed && <Badge label="NOT ARMED" color={t.warn} t={t} />}
      {status.failsafe && <Badge label="FAILSAFE: NO STATE" color={t.danger} t={t} />}
      <Badge label={status.imu_ok ? "IMU" : "NO IMU"} color={status.imu_ok ? t.ok : t.warn} t={t} />
      <Badge label={status.dvl_ok ? "DVL" : "NO DVL"} color={status.dvl_ok ? t.ok : t.warn} t={t} />
      <Badge
        label={status.depth_ok ? "DEPTH" : "NO DEPTH"}
        color={status.depth_ok ? t.ok : t.warn}
        t={t}
      />
      {lost > 0 && <Badge label={`${lost} AXIS LOST`} color={t.danger} t={t} />}
      {saturated > 0 && <Badge label={`${saturated} SATURATED`} color={t.warn} t={t} />}
      {status.killed ? (
        <span style={{ color: t.muted }}>Commands are rejected while killed</span>
      ) : (
        !status.armed && (
          <span style={{ color: t.muted }}>
            Commands are rejected until sub_control arms (its log says what it waits for)
          </span>
        )
      )}
    </span>
  );
}

export function modeName(status: ControllerStatus | undefined, axis: number): string {
  if (status == undefined) {
    return "—";
  }
  const name = MODE_NAMES[status.mode[axis] ?? -1] ?? "?";
  return status.axis_controllable[axis] === false ? `${name} (lost)` : name;
}

/** A bar from -1 to 1, filled from the middle. */
export function Bar({ value, t }: { value: number; t: Theme }): ReactElement {
  const half = Math.min(1, Math.abs(value)) * 50;
  return (
    <div
      style={{
        position: "relative",
        height: 8,
        minWidth: 50,
        background: t.surfaceStrong,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: value >= 0 ? "50%" : `${50 - half}%`,
          width: `${half}%`,
          background: t.accent,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "50%",
          width: 1,
          background: t.muted,
        }}
      />
    </div>
  );
}
