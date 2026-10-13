// Edit any node's parameters live, through its parameter services. sub_control's are grouped as
// in docs/control.md, each gain triple has a bandwidth field, and what changed can be exported
// in the layout of its gains file.

import { PanelExtensionContext, SettingsTreeNodes } from "@foxglove/extension";
import {
  Fragment,
  KeyboardEvent,
  ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

import {
  DEFAULT_NODE,
  NOT_SAVED,
  READ_ONLY,
  bandwidthOf,
  changedParams,
  elementLabels,
  formatParam,
  gainsFor,
  groupOf,
  isGain,
  parseParam,
  toYaml,
  withElement,
} from "./gains";
import { record, stringOr, useRenderState, useSettings } from "../../common/panel";
import {
  PARAMETER_BOOL,
  PARAMETER_DOUBLE,
  PARAMETER_INTEGER,
  RosParam,
  TYPE_NAMES,
  getParameters,
  listParameters,
  sameParam,
  setParameters,
} from "../../common/params";
import { Button, Card, NumberInput, Segmented, Theme, inputStyle, theme } from "../../common/ui";

type Config = {
  node: string;
  changedOnly: boolean;
  /** The values to export changes against: what the panel first saw, or "Mark as saved". */
  baseline: Record<string, RosParam> | undefined;
};

// [ms] between reads of the node's parameters, to pick up changes made elsewhere.
const REFRESH_MS = 10000;

function isRosParam(value: unknown): value is RosParam {
  const p = record(value);
  const v = p.value;
  return (
    typeof p.type === "number" &&
    (v == undefined ||
      ["boolean", "number", "string"].includes(typeof v) ||
      (Array.isArray(v) && v.every((e) => ["boolean", "number", "string"].includes(typeof e))))
  );
}

function loadConfig(saved: unknown): Config {
  const s = record(saved);
  let baseline: Record<string, RosParam> | undefined;
  if (s.baseline != undefined) {
    baseline = {};
    for (const [name, value] of Object.entries(record(s.baseline))) {
      if (isRosParam(value)) {
        baseline[name] = value;
      }
    }
  }
  return {
    node: stringOr(s.node, DEFAULT_NODE),
    changedOnly: s.changedOnly === true,
    baseline,
  };
}

function applySetting(config: Config, path: readonly string[], value: unknown): Config {
  const [, field] = path;
  if (field === "node") {
    return { ...config, node: typeof value === "string" ? value.trim() : "" };
  }
  return config;
}

function buildSettings(config: Config, nodeNames: readonly string[]): SettingsTreeNodes {
  return {
    general: {
      label: "Parameters",
      fields: {
        node: {
          label: "Node",
          input: "autocomplete",
          value: config.node,
          items: [...new Set([config.node, ...nodeNames])].filter((name) => name !== ""),
          help: "Fully qualified node name; its list/get/set_parameters services are called",
          error: config.node === "" ? "Set a node" : undefined,
        },
      },
    },
  };
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

type Row = { name: string; param: RosParam; readOnly: boolean; group: { order: number; title: string } };

function GainsPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [config, setConfig] = useState(() => loadConfig(context.initialState));
  const [nodeNames, setNodeNames] = useState<string[]>([]);
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("dark");
  const [params, setParams] = useState<Map<string, RosParam>>(new Map());
  const [staged, setStaged] = useState<Map<string, RosParam>>(new Map());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ text: string; color: string } | undefined>();
  const [filter, setFilter] = useState("");
  const t = theme(colorScheme);
  const configRef = useRef(config);
  configRef.current = config;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  // Node names, for the settings autocomplete, from whatever parameters the app has listed.
  useRenderState(context, ["parameters", "colorScheme"], (state) => {
    if (state.colorScheme) {
      setColorScheme(state.colorScheme);
    }
    if (state.parameters) {
      const names = new Set<string>();
      for (const key of state.parameters.keys()) {
        const dot = key.indexOf(".");
        if (dot > 0) {
          names.add(key.slice(0, dot));
        }
      }
      const sorted = [...names].sort();
      setNodeNames((previous) => (previous.join() === sorted.join() ? previous : sorted));
    }
  });

  const nodes = useMemo(() => buildSettings(config, nodeNames), [config, nodeNames]);
  useSettings(context, config, nodes, applySetting, setConfig);

  const load = useCallback(async () => {
    const { node } = configRef.current;
    if (node === "") {
      return;
    }
    try {
      const names = await listParameters(context, node);
      const values = await getParameters(context, node, names);
      setParams(values);
      setLoadError(undefined);
      setConfig((previous) =>
        previous.baseline == undefined && previous.node === node
          ? { ...previous, baseline: Object.fromEntries(values) }
          : previous,
      );
    } catch (failure) {
      setLoadError(`${node}: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }, [context]);

  const { node } = config;
  useEffect(() => {
    setParams(new Map());
    setStaged(new Map());
    setRowErrors(new Map());
    void load();
    const id = setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => {
      clearInterval(id);
    };
  }, [load, node]);

  const stage = useCallback(
    (name: string, next: RosParam) => {
      setStaged((previous) => {
        const updated = new Map(previous);
        const live = params.get(name);
        if (live && sameParam(live, next)) {
          updated.delete(name);
        } else {
          updated.set(name, next);
        }
        return updated;
      });
      setRowErrors((previous) => {
        if (!previous.has(name)) {
          return previous;
        }
        const updated = new Map(previous);
        updated.delete(name);
        return updated;
      });
    },
    [params],
  );

  const apply = useCallback(
    async (names: readonly string[]) => {
      const { node: target } = configRef.current;
      const entries = names.flatMap((name) => {
        const param = stagedRef.current.get(name);
        return param ? [[name, param] as const] : [];
      });
      if (entries.length === 0 || busy) {
        return;
      }
      setBusy(true);
      try {
        const results = await setParameters(context, target, entries);
        const fresh = await getParameters(
          context,
          target,
          entries.map(([name]) => name),
        );
        const errors = new Map(rowErrors);
        let applied = 0;
        setStaged((previous) => {
          const updated = new Map(previous);
          for (const result of results) {
            const wanted = previous.get(result.name);
            const live = fresh.get(result.name);
            if (!result.successful) {
              errors.set(result.name, result.reason === "" ? "rejected" : result.reason);
            } else if (wanted && live && !sameParam(wanted, live)) {
              errors.set(result.name, `applied, but reads back as ${formatParam(live)}`);
              updated.delete(result.name);
            } else {
              errors.delete(result.name);
              updated.delete(result.name);
              applied++;
            }
          }
          return updated;
        });
        setRowErrors(errors);
        setParams((previous) => new Map([...previous, ...fresh]));
        const failed = results.length - applied;
        setNotice({
          text: `${applied} applied${failed > 0 ? `, ${failed} rejected` : ""} at ${new Date().toLocaleTimeString()}`,
          color: failed > 0 ? t.warn : t.ok,
        });
      } catch (failure) {
        setNotice({
          text: failure instanceof Error ? failure.message : String(failure),
          color: t.danger,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, context, rowErrors, t.danger, t.ok, t.warn],
  );

  const baseline = useMemo(
    () => (config.baseline ? new Map(Object.entries(config.baseline)) : undefined),
    [config.baseline],
  );
  const changed = useMemo(() => changedParams(params, baseline), [params, baseline]);

  const rows = useMemo((): Row[] => {
    const all = [...params].map(([name, param]) => ({
      name,
      param,
      readOnly: READ_ONLY.has(name),
      group: groupOf(name),
    }));
    all.sort((a, b) =>
      a.group.order !== b.group.order ? a.group.order - b.group.order : a.name.localeCompare(b.name),
    );
    const needle = filter.trim().toLowerCase();
    return all.filter(
      (row) =>
        (needle === "" || row.name.toLowerCase().includes(needle)) &&
        (!config.changedOnly || staged.has(row.name) || changed.has(row.name)),
    );
  }, [params, filter, config.changedOnly, staged, changed]);

  const yaml = () => toYaml(changed);
  const yamlName = () => `${node.split("/").pop() ?? "parameters"}_${new Date().toISOString().slice(0, 10)}.yaml`;
  const copyYaml = () => {
    void navigator.clipboard.writeText(yaml()).then(
      () => {
        setNotice({ text: `Copied ${changed.size} parameters as YAML`, color: t.ok });
      },
      () => {
        setNotice({ text: "The clipboard is not available; download instead", color: t.warn });
      },
    );
  };
  const markSaved = () => {
    setConfig((previous) => ({ ...previous, baseline: Object.fromEntries(params) }));
    setNotice({ text: "Baseline set: changes are now counted from here", color: t.ok });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      void apply([...staged.keys()]);
    }
  };

  let lastGroup = "";
  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        height: "100%",
        overflow: "auto",
        boxSizing: "border-box",
        padding: 8,
        color: t.text,
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        outline: "none",
      }}
    >
      <Card
        t={t}
        title={node === "" ? "Parameters" : node}
        extra={
          <span style={{ color: t.muted }}>
            {staged.size} staged · {changed.size} changed since{" "}
            {baseline ? "the baseline" : "—"}
          </span>
        }
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input
            placeholder="Filter"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            style={{ ...inputStyle(t), width: 140 }}
          />
          <Segmented
            options={[
              { value: "all", label: "All" },
              { value: "changed", label: "Changed", title: "Staged, or different from the baseline" },
            ]}
            value={config.changedOnly ? "changed" : "all"}
            onChange={(value) => {
              setConfig((previous) => ({ ...previous, changedOnly: value === "changed" }));
            }}
            t={t}
          />
          <Button
            t={t}
            onClick={() => {
              void load();
            }}
            title="Read every parameter again (also happens every 10 s)"
          >
            Reload
          </Button>
          <Button
            t={t}
            variant="primary"
            disabled={staged.size === 0 || busy}
            onClick={() => {
              void apply([...staged.keys()]);
            }}
            title="Set every staged parameter on the node (Ctrl+S)"
          >
            Apply all
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            t={t}
            onClick={copyYaml}
            disabled={changed.size === 0}
            title="Copy the changed parameters in the gains file's layout"
          >
            Copy YAML
          </Button>
          <Button
            t={t}
            onClick={() => {
              download(yamlName(), yaml());
            }}
            disabled={changed.size === 0}
            title="Download the changed parameters in the gains file's layout"
          >
            Download YAML
          </Button>
          <Button
            t={t}
            onClick={markSaved}
            title="Take the current values as the baseline, once they are in the gains file"
          >
            Mark as saved
          </Button>
        </div>
        {loadError != undefined && <div style={{ color: t.danger }}>{loadError}</div>}
        {notice && <div style={{ color: notice.color }}>{notice.text}</div>}
        {!(context.callService != undefined) && (
          <div style={{ color: t.danger }}>
            This connection cannot call services: connect to foxglove_bridge with Foxglove WebSocket
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, auto) 1fr minmax(80px, auto)",
            columnGap: 12,
            rowGap: 4,
            alignItems: "center",
          }}
        >
          {rows.map((row) => {
            const header =
              row.group.title !== lastGroup ? (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    marginTop: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: t.muted,
                  }}
                >
                  {row.group.title}
                </div>
              ) : undefined;
            lastGroup = row.group.title;
            const pending = staged.get(row.name);
            return (
              <Fragment key={row.name}>
                {header}
                <span style={{ whiteSpace: "nowrap", fontFamily: "monospace" }} title={TYPE_NAMES[row.param.type]}>
                  {row.name}
                  {NOT_SAVED.has(row.name) && (
                    <span style={{ color: t.muted, fontFamily: "inherit" }}> (not saved)</span>
                  )}
                </span>
                <Editor
                  name={row.name}
                  live={row.param}
                  shown={pending ?? row.param}
                  readOnly={row.readOnly}
                  onStage={(next) => {
                    stage(row.name, next);
                  }}
                  onApply={() => {
                    void apply([row.name]);
                  }}
                  t={t}
                />
                <RowStatus
                  error={rowErrors.get(row.name)}
                  staged={pending != undefined}
                  changed={changed.has(row.name)}
                  readOnly={row.readOnly}
                  onApply={() => {
                    void apply([row.name]);
                  }}
                  t={t}
                />
              </Fragment>
            );
          })}
        </div>
        {rows.length === 0 && (
          <div style={{ color: t.muted }}>
            {params.size === 0 ? `Waiting for ${node}` : "No matching parameters"}
          </div>
        )}
      </Card>
    </div>
  );
}

function RowStatus({
  error,
  staged,
  changed,
  readOnly,
  onApply,
  t,
}: {
  error: string | undefined;
  staged: boolean;
  changed: boolean;
  readOnly: boolean;
  onApply: () => void;
  t: Theme;
}): ReactElement {
  if (error != undefined) {
    return <span style={{ color: t.danger }}>{error}</span>;
  }
  if (readOnly) {
    return <span style={{ color: t.muted }}>read-only</span>;
  }
  if (staged) {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <Button t={t} variant="pending" onClick={onApply} title="Set this parameter (Enter)">
          Apply
        </Button>
      </span>
    );
  }
  return <span style={{ color: changed ? t.target : t.muted }}>{changed ? "changed" : ""}</span>;
}

function Editor({
  name,
  live,
  shown,
  readOnly,
  onStage,
  onApply,
  t,
}: {
  name: string;
  live: RosParam;
  shown: RosParam;
  readOnly: boolean;
  onStage: (next: RosParam) => void;
  onApply: () => void;
  t: Theme;
}): ReactElement {
  const stagedStyle = sameParam(live, shown) ? {} : { borderColor: t.pending, color: t.pending };
  if (readOnly) {
    return <span style={{ color: t.muted, fontFamily: "monospace" }}>{formatParam(live)}</span>;
  }
  const labels = elementLabels(name, shown);
  if (labels) {
    const values = shown.value as number[];
    return (
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {labels.map((label, index) => (
          <label key={label} style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
            <span style={{ color: t.muted, fontSize: 10 }}>{label}</span>
            <NumberInput
              value={values[index]}
              digits={5}
              width={66}
              onChange={(value) => {
                if (value != undefined && Number.isFinite(value)) {
                  onStage(withElement(shown, index, value));
                }
              }}
              onEnter={onApply}
              t={t}
              style={stagedStyle}
            />
          </label>
        ))}
        {isGain(name, shown) && (
          <label
            style={{ display: "inline-flex", gap: 3, alignItems: "center" }}
            title="Bandwidth: sets [kp, ki, kd] to the critically damped [3ω², ω³, 3ω]"
          >
            <span style={{ color: t.accent, fontSize: 11 }}>ω</span>
            <NumberInput
              value={bandwidthOf(values)}
              digits={3}
              width={52}
              onChange={(value) => {
                if (value != undefined && value > 0) {
                  onStage({ type: shown.type, value: gainsFor(value) });
                }
              }}
              onEnter={onApply}
              t={t}
            />
          </label>
        )}
      </span>
    );
  }
  if (shown.type === PARAMETER_DOUBLE || shown.type === PARAMETER_INTEGER) {
    return (
      <NumberInput
        value={shown.value as number}
        digits={6}
        width={90}
        onChange={(value) => {
          if (value != undefined && Number.isFinite(value)) {
            onStage({
              type: shown.type,
              value: shown.type === PARAMETER_INTEGER ? Math.round(value) : value,
            });
          }
        }}
        onEnter={onApply}
        t={t}
        style={stagedStyle}
      />
    );
  }
  if (shown.type === PARAMETER_BOOL) {
    return (
      <Segmented
        options={[
          { value: "true", label: "true" },
          { value: "false", label: "false" },
        ]}
        value={shown.value === true ? "true" : "false"}
        onChange={(value) => {
          onStage({ type: PARAMETER_BOOL, value: value === "true" });
        }}
        t={t}
      />
    );
  }
  return <TextEditor shown={shown} onStage={onStage} onApply={onApply} style={stagedStyle} t={t} />;
}

/** Arrays and strings as text, parsed when the field is left or Enter is pressed. */
function TextEditor({
  shown,
  onStage,
  onApply,
  style,
  t,
}: {
  shown: RosParam;
  onStage: (next: RosParam) => void;
  onApply: () => void;
  style: { borderColor?: string; color?: string };
  t: Theme;
}): ReactElement {
  const [text, setText] = useState(() => formatParam(shown));
  const [error, setError] = useState<string | undefined>();
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(formatParam(shown));
    }
  }, [shown]);
  const commit = (): boolean => {
    const parsed = parseParam(text, shown.type);
    if ("error" in parsed) {
      setError(`Needs ${parsed.error}`);
      return false;
    }
    setError(undefined);
    onStage(parsed);
    return true;
  };
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (commit()) {
              onApply();
            }
          }
        }}
        style={{ ...inputStyle(t), width: 220, fontFamily: "monospace", ...style }}
      />
      {error != undefined && <span style={{ color: t.danger }}>{error}</span>}
    </span>
  );
}

export function initGainsPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<GainsPanel context={context} />);
  return () => {
    root.unmount();
  };
}
